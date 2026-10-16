import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Account } from '../../src/core/contracts/account';
import { createCipher } from '../../src/lib/crypto';
import { createIntuitTokenManager } from '../../src/intuit/token-manager';
import { createMemoryStore } from '../../src/store/memory';

async function setup() {
  const store = createMemoryStore(createCipher(randomBytes(32).toString('base64')));
  const oc = await store.orgClients.upsert({ provider: 'intuit', label: 'q', clientId: 'c', clientSecret: 's' });
  const a = await store.accounts.upsertOnConnect({ provider: 'intuit', email: 'e@e.e', label: 'q', orgClientId: oc, grantedScopes: [], realmId: '1' });
  await store.tokens.setRefreshToken(a.id, 'R0');
  return { store, a };
}

/** Fake Intuit. `strict`: only the most recently issued refresh token is valid; otherwise any issued token works. */
function fakeIntuit(strict: boolean) {
  let latest = 'R0';
  let n = 0;
  const issued = new Set(['R0']);
  const st = { calls: 0 };
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    st.calls++;
    const used = new URLSearchParams(init.body).get('refresh_token')!;
    await new Promise((r) => setTimeout(r, 50));
    if (strict ? used !== latest : !issued.has(used)) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    latest = `R${++n}`;
    issued.add(latest);
    return new Response(JSON.stringify({ access_token: `A${n}`, refresh_token: latest, expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, st, latest: () => latest };
}

describe.each([['lenient', false], ['strict', true]])('two instances refreshing at once (%s Intuit)', (_n, strict) => {
  it('exactly one call reaches Intuit, the newest refresh token is stored, nothing is stranded', async () => {
    const { store, a } = await setup();
    const intuit = fakeIntuit(strict);
    const m1 = createIntuitTokenManager({ store, fetchImpl: intuit.fetchImpl });
    const m2 = createIntuitTokenManager({ store, fetchImpl: intuit.fetchImpl });
    const [t1, t2] = await Promise.all([m1.getAccessToken(a, { forceRefresh: true }), m2.getAccessToken(a, { forceRefresh: true })]);
    expect(intuit.st.calls).toBe(1);
    expect(t1).toBe('A1');
    expect(t2).toBe('A1');
    expect(await store.tokens.getRefreshToken(a.id)).toBe(intuit.latest());
    expect((await store.accounts.list())[0]!.status).toBe('active');
    // lease released
    expect(await store.tokens.acquireRefreshLease(a.id, 1000)).toBe(true);
  });
});

describe('swap failures', () => {
  it('retries the swap once with the same expected value when it throws', async () => {
    const { store, a } = await setup();
    const real = store.tokens.swapRefreshToken;
    const seen: string[][] = [];
    let thrown = false;
    store.tokens.swapRefreshToken = async (id, expected, next) => {
      seen.push([expected, next]);
      if (!thrown) { thrown = true; throw new Error('db down'); }
      return real(id, expected, next);
    };
    const intuit = fakeIntuit(true);
    await createIntuitTokenManager({ store, fetchImpl: intuit.fetchImpl }).getAccessToken(a, { forceRefresh: true });
    expect(seen).toEqual([['R0', 'R1'], ['R0', 'R1']]);
    expect(await store.tokens.getRefreshToken(a.id)).toBe('R1');
  });
  it('releases the lease when the refresh throws', async () => {
    const { store, a } = await setup();
    const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(createIntuitTokenManager({ store, fetchImpl }).getAccessToken(a, { forceRefresh: true })).rejects.toThrow();
    expect(await store.tokens.acquireRefreshLease(a.id, 1000)).toBe(true);
  });
  it('refuses a non-intuit account without calling Intuit', async () => {
    const { store, a } = await setup();
    const fetchImpl = (async () => { throw new Error('no'); }) as unknown as typeof fetch;
    const g = { ...a, provider: 'google' } as Account;
    await expect(createIntuitTokenManager({ store, fetchImpl }).getAccessToken(g, { forceRefresh: true })).rejects.toThrow();
  });
});
