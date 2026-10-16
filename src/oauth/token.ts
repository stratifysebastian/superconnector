import { randomUUID } from 'node:crypto';
import { isAdminEmail } from '@/auth/allowlist';
import { hashToken, randomToken, timingSafeEqualStr } from '@/lib/crypto';
import type { ServerContext } from '@/server/context';
import {
  ACCESS_TTL_SECONDS,
  MCP_SCOPE,
  parseFormStrict,
  pkceS256Matches,
  readLimitedText,
  REFRESH_TTL_SECONDS,
} from './common';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers: HEADERS });
}
const invalidGrant = (d = 'The grant is invalid, expired or revoked'): Response => oauthError(400, 'invalid_grant', d);

async function issuePair(ctx: ServerContext, clientId: string, subject: string, familyId: string): Promise<Response> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  await ctx.store.oauth.saveToken({
    tokenHash: hashToken(access),
    kind: 'access',
    clientId,
    subject,
    expiresAt: now + ACCESS_TTL_SECONDS * 1000,
    familyId,
  });
  await ctx.store.oauth.saveToken({
    tokenHash: hashToken(refresh),
    kind: 'refresh',
    clientId,
    subject,
    expiresAt: now + REFRESH_TTL_SECONDS * 1000,
    familyId,
  });
  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope: MCP_SCOPE,
    }),
    { status: 200, headers: HEADERS },
  );
}

/** POST /token */
export async function handleToken(ctx: ServerContext, req: Request): Promise<Response> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return oauthError(400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const text = await readLimitedText(req, 10 * 1024);
  if (text === null) return oauthError(400, 'invalid_request', 'Request too large');
  const p = parseFormStrict(text);
  if (!p) return oauthError(400, 'invalid_request', 'Duplicate parameters are not allowed');

  const grantType = p.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return oauthError(400, 'unsupported_grant_type', 'Supported: authorization_code, refresh_token');
  }
  const clientId = p.get('client_id') ?? '';
  if (!clientId) return oauthError(400, 'invalid_request', 'client_id is required');
  const client = clientId.length > 200 ? null : await ctx.store.oauth.getClient(clientId);
  if (!client) return oauthError(400, 'invalid_client', 'Unknown client');

  return grantType === 'authorization_code'
    ? exchangeCode(ctx, p, clientId)
    : refresh(ctx, p, clientId);
}

async function exchangeCode(ctx: ServerContext, p: Map<string, string>, clientId: string): Promise<Response> {
  const code = p.get('code') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const verifier = p.get('code_verifier') ?? '';
  if (!code || !redirectUri || !verifier) {
    return oauthError(400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
  }
  if (code.length > 512) return invalidGrant();
  // Single use: the code is burned here even if a later check fails.
  const row = await ctx.store.oauth.consumeCode(hashToken(code));
  if (!row || row.expiresAt <= Date.now()) return invalidGrant();
  if (!timingSafeEqualStr(row.clientId, clientId) || !timingSafeEqualStr(row.redirectUri, redirectUri)) {
    return invalidGrant();
  }
  if (!pkceS256Matches(verifier, row.codeChallenge)) return invalidGrant('PKCE verification failed');
  if (!isAdminEmail(ctx.env, row.subject)) return invalidGrant();
  ctx.log.info({ msg: 'token issued', kind: 'authorization_code', outcome: 'ok', tool: 'oauth.token' });
  return issuePair(ctx, clientId, row.subject, randomUUID());
}

async function refresh(ctx: ServerContext, p: Map<string, string>, clientId: string): Promise<Response> {
  const token = p.get('refresh_token') ?? '';
  if (!token) return oauthError(400, 'invalid_request', 'refresh_token is required');
  if (token.length > 512) return invalidGrant();
  const hash = hashToken(token);
  const row = await ctx.store.oauth.findToken(hash);
  if (!row || row.kind !== 'refresh') return invalidGrant();

  // Bound to a different client, or already used/revoked: treat as theft and burn the family.
  if (!timingSafeEqualStr(row.clientId, clientId) || row.revoked) {
    await ctx.store.oauth.revokeFamily(row.familyId);
    ctx.log.warn({ msg: 'refresh token reuse or client mismatch; family revoked', kind: 'refresh_reuse', outcome: 'rejected', tool: 'oauth.token' });
    return invalidGrant();
  }
  if (row.expiresAt <= Date.now()) return invalidGrant();
  if (!isAdminEmail(ctx.env, row.subject)) {
    await ctx.store.oauth.revokeFamily(row.familyId);
    return invalidGrant();
  }

  // Compare-and-set: only one concurrent caller can flip revoked false -> true.
  const won = await ctx.store.oauth.revokeToken(hash);
  if (!won) {
    await ctx.store.oauth.revokeFamily(row.familyId);
    ctx.log.warn({ msg: 'refresh token reuse or race; family revoked', kind: 'refresh_reuse', outcome: 'rejected', tool: 'oauth.token' });
    return invalidGrant();
  }
  ctx.log.info({ msg: 'token refreshed', kind: 'refresh_token', outcome: 'ok', tool: 'oauth.token' });
  return issuePair(ctx, clientId, row.subject, row.familyId);
}
