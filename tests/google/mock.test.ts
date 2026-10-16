import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { Store } from '@/core/contracts/store';
import { ProviderError } from '@/core/errors';
import { resetEnvCache } from '@/lib/env';
import { getGoogleMode, isMock } from '@/google/mode';
import { loadFixture } from '@/google/mock/fixtures';
import { getMockFault, resetMockFaults, setMockFaults, withMockFaults } from '@/google/mock/faults';
import { seedMockAccounts } from '@/google/mock/seed';
import { mockAccessToken } from '@/google/mock/token';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  resetMockFaults();
  vi.unstubAllEnvs();
  resetEnvCache();
});

function fakeStore() {
  const clients: { id: string; label: string; clientId: string; clientSecret: string; workspaceDomain: string }[] = [];
  const accounts: Account[] = [];
  const store = {
    orgClients: {
      list: async () => clients.map((c) => ({ id: c.id, label: c.label, clientId: c.clientId, workspaceDomain: c.workspaceDomain })),
      get: async (id: string) => clients.find((c) => c.id === id) ?? null,
      upsert: async (c: Omit<(typeof clients)[number], 'id'> & { id?: string }) => {
        const found = clients.find((x) => x.id === c.id);
        if (found) {
          Object.assign(found, c);
          return found.id;
        }
        const id = `org-${clients.length + 1}`;
        clients.push({ ...c, id });
        return id;
      },
    },
    accounts: {
      list: async () => accounts,
      upsertOnConnect: async (a: Omit<Account, 'id' | 'priority' | 'connectedAt' | 'status'>) => {
        const found = accounts.find((x) => x.email === a.email);
        if (found) {
          Object.assign(found, a);
          return found;
        }
        const acc: Account = {
          ...a,
          id: `acc-${accounts.length + 1}`,
          priority: accounts.length,
          connectedAt: new Date().toISOString(),
          status: 'active',
        };
        accounts.push(acc);
        return acc;
      },
    },
  } as unknown as Store;
  return { store, clients, accounts };
}

describe('mode', () => {
  it('reads GOOGLE_MODE', () => {
    vi.stubEnv('GOOGLE_MODE', 'mock');
    resetEnvCache();
    expect(getGoogleMode()).toBe('mock');
    expect(isMock()).toBe(true);
  });
});

describe('fixtures', () => {
  it('loads identity fixtures', () => {
    const u = loadFixture<{ email: string; hd: string; sub: string; email_verified: boolean }>(
      'identity',
      'stratify',
      'userinfo',
    );
    expect(u).toMatchObject({ email: 'seb@stratify.example', hd: 'stratify.example', email_verified: true });
    expect(loadFixture<{ email: string }>('identity', 'prime', 'userinfo').email).toBe('seb@prime.example');
    expect(loadFixture('identity', 'stratify', 'userinfo')).toBe(loadFixture('identity', 'stratify', 'userinfo'));
  });
  it('names the path of a missing fixture', () => {
    expect(() => loadFixture('identity', 'stratify', 'nope')).toThrow(/fixtures.*identity.*stratify.*nope\.json/);
  });
  it('rejects path traversal', () => {
    expect(() => loadFixture('..', 'x', 'y')).toThrow();
  });
});

describe('faults', () => {
  it('defaults to none', async () => {
    expect(getMockFault('stratify')).toBeUndefined();
    await expect(withMockFaults('stratify', async () => 'ok')).resolves.toBe('ok');
  });
  it('invalid_grant → needs_reconnect', async () => {
    setMockFaults({ prime: 'invalid_grant' });
    const e = await withMockFaults('prime', async () => 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).kind).toBe('needs_reconnect');
    expect(await withMockFaults('stratify', async () => 1)).toBe(1);
  });
  it('rate_limited', async () => {
    setMockFaults({ prime: 'rate_limited' });
    const e = await withMockFaults({ label: 'prime' }, async () => 1).catch((x: unknown) => x);
    expect((e as ProviderError).kind).toBe('rate_limited');
  });
  it('timeout hangs until aborted, or throws on request', async () => {
    setMockFaults({ prime: 'timeout' });
    const ctrl = new AbortController();
    let settled = false;
    const p = withMockFaults('prime', async () => 1, { signal: ctrl.signal }).catch((x: unknown) => {
      settled = true;
      return x;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    ctrl.abort();
    expect(((await p) as ProviderError).kind).toBe('timeout');
    const e = await withMockFaults('prime', async () => 1, { timeoutBehaviour: 'throw' }).catch((x: unknown) => x);
    expect((e as ProviderError).kind).toBe('timeout');
  });
  it('reset clears injected faults', () => {
    setMockFaults({ prime: 'timeout' });
    resetMockFaults();
    expect(getMockFault('prime')).toBeUndefined();
  });
});

describe('token and seed', () => {
  it('mockAccessToken', () => {
    expect(mockAccessToken('prime')).toBe('mock-access-prime');
  });
  it('seeds two accounts, idempotently', async () => {
    const { store, clients, accounts } = fakeStore();
    await seedMockAccounts(store);
    await seedMockAccounts(store);
    expect(clients.map((c) => c.label)).toEqual(['stratify', 'prime']);
    expect(clients[0]).toMatchObject({ clientId: 'fake-client-id-stratify', workspaceDomain: 'stratify.example' });
    expect(accounts.map((a) => [a.email, a.label])).toEqual([
      ['seb@stratify.example', 'stratify'],
      ['seb@prime.example', 'prime'],
    ]);
    expect(accounts[0]!.orgClientId).toBe(clients[0]!.id);
    expect(accounts[0]!.grantedScopes.length).toBeGreaterThanOrEqual(6);
  });
});
