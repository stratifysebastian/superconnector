import { describe, expect, it } from 'vitest';
import { createSessionToken, verifySessionToken } from '@/auth/session-token';
import { parseEnv } from '@/lib/env';
import { createMemoryStore } from '@/store/memory';
import { createCipher } from '@/lib/crypto';
import { createServerContext } from '@/server/context';

describe('createServerContext (mock mode)', () => {
  it('seeds both mock accounts, Stratify first, with mock access tokens', async () => {
    const env = parseEnv({ GOOGLE_MODE: 'mock' });
    const store = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
    const ctx = await createServerContext({ env, store, log: { info() {}, warn() {}, error() {} } });
    const accounts = await ctx.store.accounts.list();
    expect(accounts.map((a) => a.label)).toEqual(['stratify', 'prime']);
    expect(await ctx.tokens.getAccessToken(accounts[0]!)).toBe('mock-access-stratify');
    expect(ctx.baseUrl).toBe('http://localhost:3000');
  });

  it('is idempotent when seeding twice', async () => {
    const env = parseEnv({ GOOGLE_MODE: 'mock' });
    const store = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
    const log = { info() {}, warn() {}, error() {} };
    await createServerContext({ env, store, log });
    await createServerContext({ env, store, log });
    expect((await store.accounts.list()).length).toBe(2);
  });

  it('two mock contexts without secrets get different session and cursor secrets', async () => {
    const mk = () =>
      createServerContext({
        env: parseEnv({ GOOGLE_MODE: 'mock' }),
        store: createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64'))),
        log: { info() {}, warn() {}, error() {} },
      });
    const [a, b] = [await mk(), await mk()];
    expect(a.env.SESSION_SECRET).toBeTruthy();
    expect(a.env.CURSOR_SECRET).toBeTruthy();
    expect(a.env.SESSION_SECRET).not.toBe(b.env.SESSION_SECRET);
    expect(a.env.CURSOR_SECRET).not.toBe(b.env.CURSOR_SECRET);
    expect(a.env.SESSION_SECRET).not.toBe(a.env.CURSOR_SECRET);
  });

  it('rejects a session token minted with the old public mock constant', async () => {
    const env = parseEnv({ GOOGLE_MODE: 'mock', ADMIN_EMAILS: 'a@example.test' });
    const ctx = await createServerContext({
      env,
      store: createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64'))),
      log: { info() {}, warn() {}, error() {} },
    });
    const old = await createSessionToken('a@example.test', { secret: 'mock-mode-session-secret-not-for-production-use' });
    expect(await verifySessionToken(old, ctx.env)).toBeNull();
    const fresh = await createSessionToken('a@example.test', { secret: ctx.env.SESSION_SECRET as string });
    expect((await verifySessionToken(fresh, ctx.env))?.email).toBe('a@example.test');
  });
});
