import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminSessionFromRequest } from '@/auth/session';
import { SignJWT } from 'jose';
import { deriveKey } from '@/auth/keys';
import { createSessionToken, sessionSecret, verifySessionToken } from '@/auth/session-token';
import { checkCsrf, makeCsrf } from '@/oauth/authorize';
import { parseEnv } from '@/lib/env';
import { ADMIN, get, sessionCookie, SESSION_SECRET, testEnv } from '../oauth/helpers';

afterEach(() => vi.useRealTimers());

describe('getAdminSessionFromRequest', () => {
  it('accepts a valid session', async () => {
    const s = await getAdminSessionFromRequest(get('/', await sessionCookie()), testEnv());
    expect(s?.email).toBe(ADMIN);
    expect(s!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns null for a tampered cookie', async () => {
    const c = await sessionCookie();
    const tampered = c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(await getAdminSessionFromRequest(get('/', tampered), testEnv())).toBeNull();
  });

  it('returns null for a token signed with another secret', async () => {
    const c = await sessionCookie(ADMIN, { secret: 'another-secret-another-secret-another!' });
    expect(await getAdminSessionFromRequest(get('/', c), testEnv())).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 13 * 3600;
    expect(await getAdminSessionFromRequest(get('/', await sessionCookie(ADMIN, { issuedAt })), testEnv())).toBeNull();
  });

  it('returns null when absent or when the email left the allowlist', async () => {
    expect(await getAdminSessionFromRequest(get('/'), testEnv())).toBeNull();
    const c = await sessionCookie();
    expect(await getAdminSessionFromRequest(get('/', c), testEnv({ ADMIN_EMAILS: 'someone.else@example.test' }))).toBeNull();
  });

  it('rejects an alg=none token', async () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b({ alg: 'none' })}.${b({ sub: ADMIN, exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    expect(await verifySessionToken(none, testEnv())).toBeNull();
  });
});

describe('sessionSecret', () => {
  it('uses SESSION_SECRET when set and throws otherwise, with no constant fallback', () => {
    expect(sessionSecret(testEnv())).toBe(SESSION_SECRET);
    expect(() => sessionSecret(parseEnv({ GOOGLE_MODE: 'mock' }))).toThrow();
    expect(() => sessionSecret({ SESSION_SECRET: undefined })).toThrow();
  });
});

describe('per-purpose subkeys (HKDF)', () => {
  it('derives distinct, deterministic keys per purpose', () => {
    const purposes = ['session', 'csrf', 'google-pkce', 'oidc-cookie'] as const;
    const keys = purposes.map((p) => deriveKey(SESSION_SECRET, p).toString('hex'));
    expect(new Set(keys).size).toBe(4);
    expect(deriveKey(SESSION_SECRET, 'csrf').toString('hex')).toBe(keys[1]);
    expect(deriveKey(SESSION_SECRET, 'csrf')).toHaveLength(32);
    expect(deriveKey('another-secret-another-secret-another!', 'csrf').toString('hex')).not.toBe(keys[1]);
    expect(keys).not.toContain(Buffer.from(SESSION_SECRET).toString('hex'));
  });

  it('a CSRF token cannot be verified as a session, and a session token is no CSRF token', async () => {
    const params = { clientId: 'c', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'x'.repeat(43), state: '', scope: '', resource: '' };
    const csrf = makeCsrf(SESSION_SECRET, ADMIN, params);
    expect(await verifySessionToken(csrf, testEnv())).toBeNull();
    const session = await createSessionToken(ADMIN, { secret: SESSION_SECRET });
    expect(checkCsrf(SESSION_SECRET, ADMIN, params, session)).toBe(false);
    expect(checkCsrf(SESSION_SECRET, ADMIN, params, csrf)).toBe(true);
  });

  it('a session signed with the raw secret (no HKDF) is rejected', async () => {
    const raw = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(ADMIN)
      .setIssuer('superconnector')
      .setAudience('superconnector-admin-session')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SESSION_SECRET));
    expect(await verifySessionToken(raw, testEnv())).toBeNull();
  });
});
