// Google OAuth helpers for the connect flow. Pure: every dependency is passed in.
// Together with token-manager.ts this is the only code allowed to call Google's token endpoint.
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { OrgClient, Store } from '@/core/contracts/store';
import { ALL_SCOPES } from '@/core/products';
import { deriveKeyString } from '@/auth/keys';
import { hashToken, hmacSign, randomToken } from '@/lib/crypto';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthOrgClient = Pick<OrgClient, 'clientId' | 'workspaceDomain'>;

/** Reason is plain language; never contains tokens, codes or the response body. */
export class GoogleOAuthError extends Error {
  override readonly name = 'GoogleOAuthError';
  constructor(
    readonly reason: string,
    readonly kind: 'exchange_failed' | 'invalid_id_token' = 'invalid_id_token',
  ) {
    super(reason);
  }
}

/** PKCE verifier derived from the state, so nothing needs storing. */
export function derivePkceVerifier(state: string, sessionSecret: string | undefined): string {
  if (!sessionSecret) throw new Error('A session secret is required to derive the PKCE verifier');
  return hmacSign(deriveKeyString(sessionSecret, 'google-pkce'), `google-pkce:${state}`);
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function buildGoogleAuthUrl(p: {
  orgClient: OAuthOrgClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const q = new URLSearchParams({
    client_id: p.orgClient.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: ALL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    hd: p.orgClient.workspaceDomain,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

/** Creates a state, stores only its hash (10 minutes), and returns the Google URL to redirect to. */
export async function startGoogleAuth(p: {
  store: Store;
  orgClientId: string;
  orgClient: OAuthOrgClient;
  accountId?: string;
  loginHint?: string;
  redirectUri: string;
  sessionSecret: string;
  now?: () => number;
}): Promise<string> {
  const state = randomToken();
  await p.store.oauth.saveState(hashToken(state), {
    orgClientId: p.orgClientId,
    ...(p.accountId ? { accountId: p.accountId } : {}),
    expiresAt: (p.now ?? Date.now)() + STATE_TTL_MS,
  });
  return buildGoogleAuthUrl({
    orgClient: p.orgClient,
    redirectUri: p.redirectUri,
    state,
    codeChallenge: pkceChallenge(derivePkceVerifier(state, p.sessionSecret)),
    ...(p.loginHint ? { loginHint: p.loginHint } : {}),
  });
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export async function exchangeCode(p: {
  orgClient: Pick<OrgClient, 'clientId' | 'clientSecret'>;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  const f = p.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
    client_id: p.orgClient.clientId,
    client_secret: p.orgClient.clientSecret,
  });
  let res: Response;
  try {
    res = await f(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    throw new GoogleOAuthError('Could not reach Google token endpoint', 'exchange_failed');
  }
  if (!res.ok) throw new GoogleOAuthError(`Google rejected the authorization code (HTTP ${res.status})`, 'exchange_failed');
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GoogleOAuthError('Google token response was not JSON', 'exchange_failed');
  }
  if (typeof json !== 'object' || json === null) {
    throw new GoogleOAuthError('Google token response was malformed', 'exchange_failed');
  }
  return json as TokenResponse;
}

/**
 * Reads the ID token returned by Google's token endpoint. Signature verification is skipped because
 * the token came straight from Google over TLS (OIDC Core 3.1.3.7); claims are still checked.
 */
export function readIdToken(
  idToken: string,
  expected: { clientId: string; workspaceDomain: string },
  now: () => number = Date.now,
): { email: string; sub: string } {
  let c: ReturnType<typeof decodeJwt>;
  try {
    c = decodeJwt(idToken);
  } catch {
    throw new GoogleOAuthError('ID token could not be decoded');
  }
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') {
    throw new GoogleOAuthError('ID token issuer is not Google');
  }
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(expected.clientId)) throw new GoogleOAuthError('ID token audience does not match the org client');
  if (typeof c.exp !== 'number' || c.exp * 1000 <= now()) throw new GoogleOAuthError('ID token has expired');
  const email = c['email'];
  if (typeof email !== 'string' || email.length === 0) throw new GoogleOAuthError('ID token has no email');
  if (c['email_verified'] !== true) throw new GoogleOAuthError('Google email is not verified');
  const hd = c['hd'];
  if (typeof hd !== 'string' || hd.toLowerCase() !== expected.workspaceDomain.toLowerCase()) {
    throw new GoogleOAuthError('Account is not in the expected Workspace domain');
  }
  if (typeof c.sub !== 'string' || c.sub.length === 0) throw new GoogleOAuthError('ID token has no subject');
  return { email: email.toLowerCase(), sub: c.sub };
}
