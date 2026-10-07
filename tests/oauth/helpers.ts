import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { createSessionToken, SESSION_COOKIE } from '@/auth/session-token';
import { createCipher } from '@/lib/crypto';
import { parseEnv, type Env } from '@/lib/env';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';
import type { LogEvent } from '@/core/contracts/tool';

export const BASE = 'https://mcp.example.test';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef0123';
export const ADMIN = 'seb@example.test';
export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
export const GOOGLE_CLIENT_ID = 'fake-admin-client-id.apps.example.test';

export function testEnv(over: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    GOOGLE_MODE: 'live',
    STORE: 'memory',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    SESSION_SECRET,
    CURSOR_SECRET: 'test-cursor-secret-0123456789abcdef0123',
    ADMIN_EMAILS: `${ADMIN}, Other@Example.test`,
    ADMIN_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
    ADMIN_GOOGLE_CLIENT_SECRET: 'fake-admin-client-secret',
    SUPABASE_URL: 'https://fake.supabase.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
    PUBLIC_BASE_URL: BASE,
    CRON_SECRET: 'fake-cron',
    ...over,
  });
}

export async function makeCtx(over: Record<string, string | undefined> = {}) {
  const logs: LogEvent[] = [];
  const log = {
    info: (e: LogEvent) => void logs.push(e),
    warn: (e: LogEvent) => void logs.push(e),
    error: (e: LogEvent) => void logs.push(e),
  };
  const env = testEnv(over);
  const store = createMemoryStore(createCipher(env.ENCRYPTION_KEY as string));
  const ctx: ServerContext = await createServerContext({ env, store, log });
  return { ctx, store, logs, env };
}

export async function sessionCookie(email = ADMIN, opts: { ttlSeconds?: number; issuedAt?: number; secret?: string } = {}) {
  const token = await createSessionToken(email, { secret: opts.secret ?? SESSION_SECRET, ...opts });
  return `${SESSION_COOKIE}=${token}`;
}

export function pkce() {
  const verifier = 'v'.repeat(20) + 'A'.repeat(30) + '-._~';
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function register(ctx: ServerContext, redirectUris = [REDIRECT]) {
  return ctx.store.oauth.createClient({ redirectUris, clientName: 'Test Client' });
}

export function authorizeQuery(clientId: string, challenge: string, over: Record<string, string | undefined> = {}) {
  const p: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    ...over,
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) sp.set(k, v);
  return sp;
}

export const get = (path: string, cookie?: string) =>
  new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });

export function form(path: string, params: URLSearchParams | Record<string, string>, cookie?: string, extra: Record<string, string> = {}) {
  const body = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra },
    body,
  });
}

/** Pulls hidden input values out of the consent page. */
export function hiddenFields(html: string): URLSearchParams {
  const sp = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    sp.set(m[1] as string, (m[2] as string).replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
  }
  return sp;
}

/** Full approve flow; returns the raw authorization code. */
export async function obtainCode(
  ctx: ServerContext,
  clientId: string,
  challenge: string,
  cookie: string,
  handlers: { get: typeof import('@/oauth/authorize').handleAuthorizeGet; post: typeof import('@/oauth/authorize').handleAuthorizePost },
): Promise<string> {
  const page = await handlers.get(ctx, get(`/authorize?${authorizeQuery(clientId, challenge)}`, cookie));
  const fields = hiddenFields(await page.text());
  fields.set('decision', 'approve');
  const res = await handlers.post(ctx, form('/authorize', fields, cookie));
  const loc = new URL(res.headers.get('location') as string);
  return loc.searchParams.get('code') as string;
}

export async function googleKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  return { privateKey, jwks };
}

export async function signIdToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  o: { iss?: string; aud?: string; expSeconds?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss ?? 'https://accounts.google.com')
    .setAudience(o.aud ?? GOOGLE_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.expSeconds ?? 600))
    .sign(privateKey);
}
