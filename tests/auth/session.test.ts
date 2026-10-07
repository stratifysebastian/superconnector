import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminSessionFromRequest } from '@/auth/session';
import { verifySessionToken, sessionSecret } from '@/auth/session-token';
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
  it('uses SESSION_SECRET when set and a constant only in mock mode', () => {
    expect(sessionSecret(testEnv())).toBe(SESSION_SECRET);
    expect(sessionSecret(parseEnv({ GOOGLE_MODE: 'mock' }))).toContain('mock');
    expect(() => sessionSecret({ GOOGLE_MODE: 'live', SESSION_SECRET: undefined })).toThrow();
  });
});
