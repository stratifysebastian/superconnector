import { describe, expect, it } from 'vitest';
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
});
