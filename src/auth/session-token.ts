import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '@/lib/env';
import { isAdminEmail } from './allowlist';

export const SESSION_COOKIE = 'sc_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const ISSUER = 'superconnector';
const AUDIENCE = 'superconnector-admin-session';

/** Used ONLY in mock mode, where SESSION_SECRET is not required. Never used when GOOGLE_MODE=live. */
const MOCK_ONLY_SESSION_SECRET = 'mock-mode-session-secret-not-for-production-use';

/** The session HMAC secret. Live mode: getEnv already guarantees SESSION_SECRET; if absent we throw. */
export function sessionSecret(env: Pick<Env, 'GOOGLE_MODE' | 'SESSION_SECRET'>): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.GOOGLE_MODE === 'mock') return MOCK_ONLY_SESSION_SECRET;
  throw new Error('SESSION_SECRET is required');
}

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export interface MintOptions {
  ttlSeconds?: number;
  /** Seconds since epoch; defaults to now. */
  issuedAt?: number;
}

/** Signs an HS256 session JWT `{ sub: email }`. */
export async function mintSessionToken(secret: string, email: string, opts: MintOptions = {}): Promise<string> {
  const iat = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(email.trim().toLowerCase())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttlSeconds ?? SESSION_TTL_SECONDS))
    .sign(keyOf(secret));
}

/** TEST-ONLY helper: mints a session token for tests. No route exposes it. */
export async function createSessionToken(email: string, opts: MintOptions & { secret: string }): Promise<string> {
  return mintSessionToken(opts.secret, email, opts);
}

export interface VerifiedSession {
  email: string;
  expiresAt: number;
}

/** Verifies signature, expiry and the CURRENT allowlist. Null on any failure. */
export async function verifySessionToken(
  token: string | undefined,
  env: Pick<Env, 'GOOGLE_MODE' | 'SESSION_SECRET' | 'ADMIN_EMAILS'>,
): Promise<VerifiedSession | null> {
  if (!token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, keyOf(sessionSecret(env)), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ['sub', 'exp'],
    });
    const email = typeof payload.sub === 'string' ? payload.sub.toLowerCase() : '';
    if (!isAdminEmail(env, email) || typeof payload.exp !== 'number') return null;
    return { email, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}
