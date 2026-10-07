import { getAdminSessionFromRequest } from '@/auth/session';
import { escapeHtml, htmlResponse, messagePage, pageHeaders } from '@/auth/html';
import { sessionSecret } from '@/auth/session-token';
import { hashToken, hmacSign, randomToken, timingSafeEqualStr } from '@/lib/crypto';
import type { ServerContext } from '@/server/context';
import {
  CODE_TTL_SECONDS,
  isValidChallenge,
  MCP_SCOPE,
  mcpResource,
  parseFormStrict,
  readLimitedText,
  singleParams,
} from './common';

const MAX_STATE = 1024;
const CSRF_MAX_AGE_MS = 15 * 60 * 1000;

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string; // '' when absent
  scope: string; // '' when absent
  resource: string; // '' when absent
}

type Validation =
  | { kind: 'page_error'; message: string }
  | { kind: 'redirect_error'; redirectUri: string; error: string; description: string; state: string }
  | { kind: 'ok'; params: AuthorizeParams; clientName: string };

async function validate(ctx: ServerContext, p: Map<string, string> | null): Promise<Validation> {
  if (!p) return { kind: 'page_error', message: 'Duplicate request parameters are not allowed.' };
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  if (!clientId || !redirectUri) return { kind: 'page_error', message: 'client_id and redirect_uri are required.' };
  const client = clientId.length > 200 ? null : await ctx.store.oauth.getClient(clientId);
  if (!client) return { kind: 'page_error', message: 'Unknown client.' };
  if (!client.redirectUris.includes(redirectUri)) {
    return { kind: 'page_error', message: 'The redirect URI is not registered for this client.' };
  }
  // From here on the redirect URI is trusted, so errors go back to the client.
  const state = p.get('state') ?? '';
  const fail = (error: string, description: string): Validation => ({
    kind: 'redirect_error',
    redirectUri,
    error,
    description,
    state: state.length > MAX_STATE ? '' : state,
  });
  if (state.length > MAX_STATE) return fail('invalid_request', 'state too long');
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const challenge = p.get('code_challenge') ?? '';
  if (!challenge) return fail('invalid_request', 'code_challenge is required');
  if (p.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  if (!isValidChallenge(challenge)) return fail('invalid_request', 'code_challenge is malformed');
  const scope = p.get('scope') ?? '';
  if (scope && !scope.split(' ').every((s) => s === MCP_SCOPE)) return fail('invalid_scope', 'Only the mcp scope exists');
  const resource = p.get('resource') ?? '';
  if (resource && resource !== mcpResource(ctx.baseUrl)) return fail('invalid_target', 'Unknown resource');
  const named = (client as { clientName?: unknown }).clientName;
  return {
    kind: 'ok',
    params: { clientId, redirectUri, codeChallenge: challenge, state, scope, resource },
    clientName: typeof named === 'string' && named ? named : clientId,
  };
}

function redirectWith(redirectUri: string, params: Record<string, string>, state: string): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (state) u.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}

const errorPage = (message: string): Response => messagePage(400, 'Authorization request error', message);

// CSRF token: `<ts>.<hmac(session subject + request parameters)>`.
function csrfMac(secret: string, ts: string, sub: string, p: AuthorizeParams): string {
  return hmacSign(secret, JSON.stringify(['authorize-csrf', ts, sub, p.clientId, p.redirectUri, p.codeChallenge, p.state, p.scope, p.resource]));
}
export function makeCsrf(secret: string, sub: string, p: AuthorizeParams, now = Date.now()): string {
  const ts = String(now);
  return `${ts}.${csrfMac(secret, ts, sub, p)}`;
}
export function checkCsrf(secret: string, sub: string, p: AuthorizeParams, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const ts = token.slice(0, dot);
  const age = now - Number(ts);
  if (!/^\d+$/.test(ts) || !Number.isFinite(age) || age < -60_000 || age > CSRF_MAX_AGE_MS) return false;
  return timingSafeEqualStr(csrfMac(secret, ts, sub, p), token.slice(dot + 1));
}

function consentPage(ctx: ServerContext, v: Extract<Validation, { kind: 'ok' }>, email: string, csrf: string): Response {
  const p = v.params;
  const hidden = (n: string, val: string): string => `<input type="hidden" name="${n}" value="${escapeHtml(val)}">`;
  let host = '';
  try {
    host = new URL(p.redirectUri).host;
  } catch {
    host = '';
  }
  const body =
    `<h1>Authorize access</h1>` +
    `<p><strong>${escapeHtml(v.clientName)}</strong> wants to connect to your Google accounts through this server.</p>` +
    `<dl><dt>Client ID</dt><dd>${escapeHtml(p.clientId)}</dd>` +
    `<dt>You will be sent back to</dt><dd>${escapeHtml(host)}</dd>` +
    `<dt>Signed in as</dt><dd>${escapeHtml(email)}</dd></dl>` +
    `<form method="post" action="${escapeHtml(ctx.baseUrl)}/authorize">` +
    hidden('response_type', 'code') +
    hidden('client_id', p.clientId) +
    hidden('redirect_uri', p.redirectUri) +
    hidden('code_challenge', p.codeChallenge) +
    hidden('code_challenge_method', 'S256') +
    hidden('state', p.state) +
    hidden('scope', p.scope) +
    hidden('resource', p.resource) +
    hidden('csrf', csrf) +
    `<button type="submit" name="decision" value="approve">Approve</button>` +
    `<button type="submit" name="decision" value="deny">Deny</button></form>`;
  return htmlResponse(200, 'Authorize access', body, pageHeaders());
}

function signinRedirect(ctx: ServerContext, req: Request): Response {
  const u = new URL(req.url);
  const next = `${u.pathname}${u.search}`;
  const loc = `${ctx.baseUrl}/signin?next=${encodeURIComponent(next)}`;
  return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store' } });
}

/** GET /authorize */
export async function handleAuthorizeGet(ctx: ServerContext, req: Request): Promise<Response> {
  const v = await validate(ctx, singleParams(new URL(req.url).searchParams));
  if (v.kind === 'page_error') return errorPage(v.message);
  if (v.kind === 'redirect_error') return redirectWith(v.redirectUri, { error: v.error, error_description: v.description }, v.state);
  const session = await getAdminSessionFromRequest(req, ctx.env);
  if (!session) return signinRedirect(ctx, req);
  const csrf = makeCsrf(sessionSecret(ctx.env), session.email, v.params);
  return consentPage(ctx, v, session.email, csrf);
}

/** POST /authorize (form submit from the consent page) */
export async function handleAuthorizePost(ctx: ServerContext, req: Request): Promise<Response> {
  const text = await readLimitedText(req, 16 * 1024);
  if (text === null) return errorPage('Request too large.');
  const form = parseFormStrict(text);
  const v = await validate(ctx, form);
  if (v.kind === 'page_error') return errorPage(v.message);
  if (v.kind === 'redirect_error') return redirectWith(v.redirectUri, { error: v.error, error_description: v.description }, v.state);

  const session = await getAdminSessionFromRequest(req, ctx.env);
  if (!session) return messagePage(401, 'Signed out', 'Your session expired. Open the authorization link again.', { href: '/signin', text: 'Sign in' });
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(ctx.baseUrl).origin) return messagePage(403, 'Forbidden', 'Cross-origin request refused.');
  if (!checkCsrf(sessionSecret(ctx.env), session.email, v.params, form?.get('csrf') ?? '')) {
    return messagePage(403, 'Forbidden', 'Invalid or expired form token. Open the authorization link again.');
  }

  if (form?.get('decision') !== 'approve') {
    return redirectWith(v.params.redirectUri, { error: 'access_denied' }, v.params.state);
  }
  const code = randomToken();
  await ctx.store.oauth.saveCode({
    codeHash: hashToken(code),
    clientId: v.params.clientId,
    redirectUri: v.params.redirectUri,
    codeChallenge: v.params.codeChallenge,
    subject: session.email,
    expiresAt: Date.now() + CODE_TTL_SECONDS * 1000,
  });
  ctx.log.info({ msg: 'authorization granted', outcome: 'ok', tool: 'oauth.authorize' });
  return redirectWith(v.params.redirectUri, { code }, v.params.state);
}
