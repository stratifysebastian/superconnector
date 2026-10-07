import { describe, expect, it } from 'vitest';
import type { Store } from '@/core/contracts/store';
import type { Account } from '@/core/contracts/account';
import type { LogEvent } from '@/core/contracts/tool';
import { ProviderError } from '@/core/errors';
import { handleHealthRequest } from '@/cron/handler';
import { runHealthCheck } from '@/cron/health';
import type { TokenManager } from '@/google/token-manager';
import { createCipher } from '@/lib/crypto';
import { parseEnv } from '@/lib/env';
import { createServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';

const SECRET = 'fake-cron-secret-0123456789abcdef0123456789';

async function setup(tokensOrFactory: TokenManager | ((s: Store) => TokenManager), cronSecret?: string) {
  const logs: LogEvent[] = [];
  const log = {
    info: (e: LogEvent) => void logs.push(e),
    warn: (e: LogEvent) => void logs.push(e),
    error: (e: LogEvent) => void logs.push(e),
  };
  const env = parseEnv({ GOOGLE_MODE: 'mock', ...(cronSecret ? { CRON_SECRET: cronSecret } : {}) });
  const store = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
  const tokens = typeof tokensOrFactory === 'function' ? tokensOrFactory(store) : tokensOrFactory;
  const ctx = await createServerContext({ env, store, log, tokens });
  return { ctx, logs, store };
}

const healthy: TokenManager = { getAccessToken: async () => 'fake-access-token' };

describe('runHealthCheck', () => {
  it('reports both accounts ok', async () => {
    const { ctx } = await setup(healthy);
    const s = await runHealthCheck(ctx);
    expect(s.results).toEqual([
      { label: 'stratify', status: 'ok' },
      { label: 'prime', status: 'ok' },
    ]);
    expect(Number.isNaN(Date.parse(s.checkedAt))).toBe(false);
  });

  it('flags prime needs_reconnect and leaves stratify active', async () => {
    const r = await setup((store) => ({
      async getAccessToken(a: Account) {
        if (a.label === 'prime') {
          await store.accounts.setStatus(a.id, 'needs_reconnect');
          throw new ProviderError('needs_reconnect', 'invalid_grant for seb@prime.example');
        }
        return 'fake';
      },
    }));
    const store = r.store;
    const s = await runHealthCheck(r.ctx);
    expect(s.results).toEqual([
      { label: 'stratify', status: 'ok' },
      { label: 'prime', status: 'needs_reconnect', kind: 'needs_reconnect' },
    ]);
    const statuses = Object.fromEntries((await store.accounts.list()).map((a) => [a.label, a.status]));
    expect(statuses).toEqual({ stratify: 'active', prime: 'needs_reconnect' });
    expect(JSON.stringify(r.logs)).not.toContain('prime.example');
  });

  it('records a generic error without leaking its message', async () => {
    const tokens: TokenManager = {
      async getAccessToken(a) {
        if (a.label === 'prime') throw new Error('boom ya29.fake-leaky-token seb@prime.example');
        return 'fake';
      },
    };
    const { ctx, logs } = await setup(tokens);
    const s = await runHealthCheck(ctx);
    expect(s.results[1]).toEqual({ label: 'prime', status: 'error', kind: 'unknown' });
    const all = JSON.stringify([s, logs]);
    expect(all).not.toContain('boom');
    expect(all).not.toContain('ya29');
    expect(all).not.toContain('prime.example');
  });

  it('records other ProviderError kinds as error', async () => {
    const tokens: TokenManager = {
      async getAccessToken(a) {
        if (a.label === 'prime') throw new ProviderError('timeout', 'slow');
        return 'fake';
      },
    };
    const { ctx } = await setup(tokens);
    expect((await runHealthCheck(ctx)).results[1]).toEqual({ label: 'prime', status: 'error', kind: 'timeout' });
  });

  it('does not call the token manager for needs_reconnect accounts', async () => {
    const called: string[] = [];
    const tokens: TokenManager = {
      async getAccessToken(a) {
        called.push(a.label);
        return 'fake';
      },
    };
    const { ctx, store } = await setup(tokens);
    const prime = (await store.accounts.list()).find((a) => a.label === 'prime')!;
    await store.accounts.setStatus(prime.id, 'needs_reconnect');
    const s = await runHealthCheck(ctx);
    expect(called).toEqual(['stratify']);
    expect(s.results[1]).toEqual({ label: 'prime', status: 'needs_reconnect', kind: 'needs_reconnect' });
  });
});

describe('GET /api/cron/health handler', () => {
  const req = (auth?: string) =>
    new Request('http://localhost/api/cron/health', { headers: auth ? { authorization: auth } : {} });

  it('401 without a header', async () => {
    const { ctx } = await setup(healthy, SECRET);
    const res = await handleHealthRequest(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('401 with a wrong header', async () => {
    const { ctx } = await setup(healthy, SECRET);
    expect((await handleHealthRequest(req('Bearer wrong'), ctx)).status).toBe(401);
    expect((await handleHealthRequest(req(SECRET), ctx)).status).toBe(401);
  });

  it('200 with the summary and no secret in logs', async () => {
    const { ctx, logs } = await setup(healthy, SECRET);
    const res = await handleHealthRequest(req(`Bearer ${SECRET}`), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('503 when CRON_SECRET is unset, even with a header', async () => {
    const { ctx } = await setup(healthy);
    const res = await handleHealthRequest(req('Bearer anything'), ctx);
    expect(res.status).toBe(503);
  });
});
