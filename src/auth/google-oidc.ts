import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { randomToken } from '@/lib/crypto';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

let remoteJwks: JWTVerifyGetKey | undefined;
function defaultJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

export class OidcError extends Error {
  constructor(readonly reason: 'exchange' | 'token' | 'nonce' | 'email') {
    super(`OIDC ${reason} failure`);
  }
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') };
}

export function buildGoogleAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/** Exchanges the authorization code for an ID token. The response body is never logged or put in errors. */
export async function exchangeCodeForIdToken(
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string },
  fetchFn: FetchFn = defaultFetch,
): Promise<string> {
  try {
    const res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: p.code,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        redirect_uri: p.redirectUri,
        code_verifier: p.verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error('bad status');
    const json = (await res.json()) as { id_token?: unknown };
    if (typeof json.id_token !== 'string' || json.id_token.length === 0) throw new Error('no id_token');
    return json.id_token;
  } catch {
    throw new OidcError('exchange');
  }
}

/** Verifies signature, iss, aud, exp, nonce and email_verified; returns the lowercase email. */
export async function verifyGoogleIdToken(
  idToken: string,
  p: { clientId: string; nonce: string },
  jwks?: JWTVerifyGetKey,
): Promise<string> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks ?? defaultJwks(), {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      audience: p.clientId,
      requiredClaims: ['exp', 'iat'],
    }));
  } catch {
    throw new OidcError('token');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== p.nonce) throw new OidcError('nonce');
  const verified = payload.email_verified;
  if (verified !== true && verified !== 'true') throw new OidcError('email');
  if (typeof payload.email !== 'string' || payload.email.length === 0) throw new OidcError('email');
  return payload.email.trim().toLowerCase();
}
