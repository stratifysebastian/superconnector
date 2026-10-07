import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt, type JWTVerifyGetKey } from 'jose';
import { randomToken, timingSafeEqualStr } from '@/lib/crypto';
import type { ServerContext } from '@/server/context';
import { isAdminEmail } from './allowlist';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import {
  buildGoogleAuthUrl,
  exchangeCodeForIdToken,
  newPkce,
  OidcError,
  verifyGoogleIdToken,
  type FetchFn,
} from './google-oidc';
import { messagePage } from './html';
import { sanitizeNext } from './redirect';
import { mintSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionSecret } from './session-token';

export const OIDC_COOKIE = 'sc_oidc';
const OIDC_PATH = '/api/auth';
const OIDC_TTL_SECONDS = 10 * 60;
const OIDC_ISSUER = 'superconnector';
const OIDC_AUDIENCE = 'superconnector-oidc-state';

export interface SigninDeps {
  /** JWKS used to verify Google ID tokens (injectable for tests). */
  jwks?: JWTVerifyGetKey;
  /** Token endpoint fetch (injectable for tests). */
  fetchFn?: FetchFn;
}

interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

const oidcKey = (secret: string): Uint8Array =>
  createHash('sha256').update(`oidc-cookie|${secret}`, 'utf8').digest();

async function sealOidc(secret: string, s: OidcState): Promise<string> {
  return new EncryptJWT({ ...s })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(OIDC_ISSUER)
    .setAudience(OIDC_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${OIDC_TTL_SECONDS}s`)
    .encrypt(oidcKey(secret));
}

async function openOidc(secret: string, value: string | undefined): Promise<OidcState | null> {
  if (!value || value.length > 4096) return null;
  try {
    const { payload } = await jwtDecrypt(value, oidcKey(secret), {
      issuer: OIDC_ISSUER,
      audience: OIDC_AUDIENCE,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    const { state, nonce, verifier, next } = payload as Record<string, unknown>;
    if (
      typeof state !== 'string' ||
      typeof nonce !== 'string' ||
      typeof verifier !== 'string' ||
      typeof next !== 'string'
    )
      return null;
    return { state, nonce, verifier, next };
  } catch {
    return null;
  }
}

const redirectUriOf = (ctx: ServerContext): string => `${ctx.baseUrl}/api/auth/callback`;

function textStatus(status: number, message: string): Response {
  return messagePage(status, message, '');
}

function configured(ctx: ServerContext): { clientId: string; clientSecret: string } | null {
  const { ADMIN_GOOGLE_CLIENT_ID: clientId, ADMIN_GOOGLE_CLIENT_SECRET: clientSecret } = ctx.env;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** GET /api/auth/start */
export async function handleSigninStart(ctx: ServerContext, req: Request): Promise<Response> {
  const cfg = configured(ctx);
  if (!cfg) return textStatus(503, 'Admin sign-in is not configured');
  const next = sanitizeNext(new URL(req.url).searchParams.get('next'));
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = newPkce();
  const cookie = await sealOidc(sessionSecret(ctx.env), { state, nonce, verifier, next });
  const location = buildGoogleAuthUrl({
    clientId: cfg.clientId,
    redirectUri: redirectUriOf(ctx),
    state,
    nonce,
    challenge,
  });
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', serializeCookie(OIDC_COOKIE, cookie, { maxAge: OIDC_TTL_SECONDS, path: OIDC_PATH }));
  return new Response(null, { status: 302, headers });
}

function failure(status: number, title: string, message: string): Response {
  const res = messagePage(status, title, message, { href: '/signin', text: 'Back to sign in' });
  res.headers.append('Set-Cookie', clearCookie(OIDC_COOKIE, OIDC_PATH));
  return res;
}

/** GET /api/auth/callback */
export async function handleSigninCallback(
  ctx: ServerContext,
  req: Request,
  deps: SigninDeps = {},
): Promise<Response> {
  const cfg = configured(ctx);
  if (!cfg) return textStatus(503, 'Admin sign-in is not configured');
  const secret = sessionSecret(ctx.env);
  const sp = new URL(req.url).searchParams;
  const saved = await openOidc(secret, parseCookies(req.headers.get('cookie')).get(OIDC_COOKIE));
  const state = sp.get('state');
  if (!saved || !state || !timingSafeEqualStr(state, saved.state)) {
    return failure(400, 'Sign-in failed', 'The sign-in attempt expired or is invalid. Please try again.');
  }
  const code = sp.get('code');
  if (sp.get('error') || !code) {
    return failure(400, 'Sign-in cancelled', 'Google did not complete the sign-in.');
  }

  let email: string;
  try {
    const idToken = await exchangeCodeForIdToken(
      {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        redirectUri: redirectUriOf(ctx),
        code,
        verifier: saved.verifier,
      },
      deps.fetchFn,
    );
    email = await verifyGoogleIdToken(idToken, { clientId: cfg.clientId, nonce: saved.nonce }, deps.jwks);
  } catch (e) {
    const reason = e instanceof OidcError ? e.reason : 'unknown';
    ctx.log.warn({ msg: 'admin sign-in rejected', kind: reason, outcome: 'rejected' });
    return failure(403, 'Sign-in failed', 'Google sign-in could not be verified.');
  }

  if (!isAdminEmail(ctx.env, email)) {
    ctx.log.warn({ msg: 'admin sign-in rejected', kind: 'not_allowlisted', outcome: 'rejected' });
    return failure(403, 'Access denied', 'This Google account is not allowed');
  }

  const session = await mintSessionToken(secret, email);
  const headers = new Headers({
    Location: new URL(sanitizeNext(saved.next), ctx.baseUrl).toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS, path: '/' }));
  headers.append('Set-Cookie', clearCookie(OIDC_COOKIE, OIDC_PATH));
  return new Response(null, { status: 302, headers });
}

/** POST /api/auth/signout */
export async function handleSignout(ctx: ServerContext, req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(ctx.baseUrl).origin) return textStatus(403, 'Forbidden');
  const headers = new Headers({ Location: new URL('/signin', ctx.baseUrl).toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE, '/'));
  return new Response(null, { status: 303, headers });
}
