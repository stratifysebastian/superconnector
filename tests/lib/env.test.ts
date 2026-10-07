import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, parseEnv, resetEnvCache } from '@/lib/env';

const goodKey = Buffer.alloc(32, 7).toString('base64');

const liveEnv = (): Record<string, string> => ({
  GOOGLE_MODE: 'live',
  ENCRYPTION_KEY: goodKey,
  SESSION_SECRET: 'test-secret-session-aaaaaaaaaaaaaaaaaaaa',
  CURSOR_SECRET: 'test-secret-cursor-bbbbbbbbbbbbbbbbbbbbb',
  ADMIN_EMAILS: 'Admin@Example.com, other@example.com',
  ADMIN_GOOGLE_CLIENT_ID: 'test-client-id',
  ADMIN_GOOGLE_CLIENT_SECRET: 'test-secret-client',
  SUPABASE_URL: 'https://example.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-secret-service-role',
  PUBLIC_BASE_URL: 'https://mcp.example.test',
  CRON_SECRET: 'test-secret-cron',
});

afterEach(() => {
  resetEnvCache();
});

describe('env', () => {
  it('mock mode passes with no secrets and defaults', () => {
    const env = parseEnv({});
    expect(env.GOOGLE_MODE).toBe('mock');
    expect(env.STORE).toBe('memory');
    expect(env.ADMIN_EMAILS).toEqual([]);
  });

  it('live mode with everything set parses, lowercases admin emails, defaults store to supabase', () => {
    const env = parseEnv(liveEnv());
    expect(env.STORE).toBe('supabase');
    expect(env.ADMIN_EMAILS).toEqual(['admin@example.com', 'other@example.com']);
  });

  it('live mode missing ENCRYPTION_KEY throws and names it', () => {
    const e = liveEnv();
    delete (e as Record<string, string | undefined>).ENCRYPTION_KEY;
    expect(() => parseEnv(e)).toThrow(/ENCRYPTION_KEY/);
  });

  it('wrong-length key throws and does not echo the value', () => {
    const e = { ...liveEnv(), ENCRYPTION_KEY: Buffer.alloc(16, 9).toString('base64') };
    let msg = '';
    try {
      parseEnv(e);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/ENCRYPTION_KEY/);
    expect(msg).not.toContain(e.ENCRYPTION_KEY);
  });

  it('error messages never contain seeded secret values', () => {
    const e = { ...liveEnv(), SESSION_SECRET: 'test-secret-short', SUPABASE_URL: 'not-a-url-test-secret-zzz' };
    delete (e as Record<string, string | undefined>).CRON_SECRET;
    let msg = '';
    try {
      parseEnv(e);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/SESSION_SECRET/);
    expect(msg).toMatch(/CRON_SECRET/);
    for (const [k, v] of Object.entries(e)) {
      if (k !== 'GOOGLE_MODE') expect(msg).not.toContain(v);
    }
  });

  it('getEnv is lazy and cached until reset', () => {
    const prev = process.env.GOOGLE_MODE;
    process.env.GOOGLE_MODE = 'mock';
    try {
      const a = getEnv();
      expect(getEnv()).toBe(a);
      resetEnvCache();
      expect(getEnv()).not.toBe(a);
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_MODE;
      else process.env.GOOGLE_MODE = prev;
    }
  });
});
