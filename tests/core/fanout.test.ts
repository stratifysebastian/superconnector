import { describe, expect, it, vi } from 'vitest';
import type { Account } from '../../src/core/contracts/account';
import type { AccountPage } from '../../src/core/contracts/fanout';
import { resolveAccounts } from '../../src/core/accounts';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../../src/core/cursor';
import { createFanOutEngine } from '../../src/core/fanout';
import { AccountSelectionError, ProviderError } from '../../src/core/errors';

const SECRET = 'test-secret';
const mk = (label: string, priority: number, status: Account['status'] = 'active'): Account => ({
  id: label,
  provider: 'google',
  email: `${label}@example.com`,
  label,
  orgClientId: 'c',
  priority,
  connectedAt: '2026-01-01T00:00:00Z',
  status,
  grantedScopes: [],
});
const stratify = mk('stratify', 0);
const prime = mk('prime', 1);
const engineFor = (accts: Account[]) =>
  createFanOutEngine({ listAccounts: async () => accts, cursorSecret: SECRET, reconnectUrl: '/connect' });

interface Item {
  id: string;
  t: number;
  key?: string;
}

describe('resolveAccounts', () => {
  const accts = [prime, stratify]; // deliberately unsorted
  it('handles undefined and all in priority order', () => {
    expect(resolveAccounts(undefined, accts).map((a) => a.label)).toEqual(['stratify', 'prime']);
    expect(resolveAccounts('all', accts).map((a) => a.label)).toEqual(['stratify', 'prime']);
  });
  it('resolves label, email, case-insensitively', () => {
    expect(resolveAccounts('PRIME', accts)[0]?.label).toBe('prime');
    expect(resolveAccounts('Stratify@Example.com', accts)[0]?.label).toBe('stratify');
  });
  it('resolves mixed lists in priority order, de-duplicated', () => {
    const r = resolveAccounts(['prime', 'stratify@example.com', 'PRIME', 'stratify'], accts);
    expect(r.map((a) => a.label)).toEqual(['stratify', 'prime']);
  });
  it('rejects unknown with valid labels', () => {
    expect(() => resolveAccounts('foo', accts)).toThrow(
      'Unknown account "foo". Connected accounts: stratify, prime.',
    );
    expect(() => resolveAccounts(['prime', 'foo'], accts)).toThrow(AccountSelectionError);
  });
  it('rejects an empty list', () => {
    expect(() => resolveAccounts([], accts)).toThrow(AccountSelectionError);
  });
});

describe('cursor', () => {
  it('round trips', () => {
    const s = { stratify: { pageToken: 'abc', offset: 2 }, prime: { offset: 0 } };
    expect(decodeCursor(encodeCursor(s, SECRET), SECRET)).toEqual(s);
  });
  it('rejects tampering, wrong secret and garbage', () => {
    const c = encodeCursor({ stratify: { offset: 1 } }, SECRET);
    const [p, sig] = c.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ prime: { offset: 1 } })).toString('base64url');
    expect(() => decodeCursor(`${forged}.${sig}`, SECRET)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(c, 'other')).toThrow(InvalidCursorError);
    expect(() => decodeCursor('garbage', SECRET)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(`${p}.`, SECRET)).toThrow(InvalidCursorError);
    expect(() => decodeCursor('', SECRET)).toThrow(AccountSelectionError);
  });
});

function pagedFetcher(data: Record<string, Item[][]>) {
  return vi.fn(async (a: Account, token: string | undefined): Promise<AccountPage<Item>> => {
    const pages = data[a.label] ?? [];
    const i = token ? Number(token) : 0;
    return { items: pages[i] ?? [], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined };
  });
}

describe('read: merge', () => {
  it('merges newest first, ties by priority', async () => {
    const fetch = pagedFetcher({
      stratify: [[{ id: 's1', t: 10 }, { id: 's2', t: 5 }, { id: 's3', t: 1 }]],
      prime: [[{ id: 'p1', t: 8 }, { id: 'p2', t: 5 }]],
    });
    const r = await engineFor([prime, stratify]).read({
      selector: undefined,
      page: { pageSize: 10 },
      fetch,
      dateOf: (i) => i.t,
    });
    expect(r.items.map((i) => i.id)).toEqual(['s1', 'p1', 's2', 'p2', 's3']);
    expect(r.items[1]).toMatchObject({ account: 'prime', accountEmail: 'prime@example.com' });
    expect(r.accountErrors).toEqual([]);
    expect(r.nextCursor).toBeUndefined();
    expect(r.items[0]).not.toHaveProperty('accounts');
  });
});

describe('read: de-dup', () => {
  it('collapses calendar-style duplicates', async () => {
    const data: Record<string, Item[][]> = {
      stratify: [[{ id: 'evS', t: 10, key: 'uid1|10' }, { id: 'only', t: 3, key: 'uid2|3' }]],
      prime: [[{ id: 'evP', t: 10, key: 'uid1|10' }]],
    };
    const r = await engineFor([stratify, prime]).read({
      selector: 'all',
      page: { pageSize: 10 },
      fetch: pagedFetcher(data),
      dateOf: (i) => i.t,
      dedupeKey: (i) => i.key,
      idOf: (i) => ({ id: i.id, calendarId: 'cal-' + i.id }),
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      id: 'evS',
      account: 'stratify',
      accounts: ['stratify', 'prime'],
      sources: [
        { account: 'stratify', id: 'evS', calendarId: 'cal-evS' },
        { account: 'prime', id: 'evP', calendarId: 'cal-evP' },
      ],
    });
    expect(r.items[1]).toMatchObject({ accounts: ['stratify'], sources: [{ account: 'stratify', id: 'only' }] });
  });
  it('collapses drive-style duplicates and keeps the highest priority copy', async () => {
    const data: Record<string, Item[][]> = {
      stratify: [[{ id: 'f1', t: 4, key: 'f1' }]],
      prime: [[{ id: 'f1', t: 9, key: 'f1' }]],
    };
    const r = await engineFor([stratify, prime]).read({
      selector: undefined,
      page: { pageSize: 10 },
      fetch: pagedFetcher(data),
      dateOf: (i) => i.t,
      dedupeKey: (i) => i.key,
      idOf: (i) => ({ id: i.id }),
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ account: 'stratify', t: 4, accounts: ['stratify', 'prime'] });
  });
});

describe('read: paging', () => {
  const build = (): Record<string, Item[][]> => {
    // distinct descending dates within each account across 3 pages of 3
    const mkp = (l: string, off: number): Item[][] =>
      [0, 1, 2].map((p) => [0, 1, 2].map((k) => ({ id: `${l}${p * 3 + k}`, t: 100 - (p * 3 + k) * 2 - off })));
    return { stratify: mkp('s', 0), prime: mkp('p', 1) };
  };
  for (const pageSize of [2, 4, 5, 20]) {
    it(`sees every item exactly once in order (pageSize ${pageSize})`, async () => {
      const engine = engineFor([stratify, prime]);
      const fetch = pagedFetcher(build());
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const r = await engine.read({
          selector: undefined,
          page: { pageSize, cursor },
          fetch,
          dateOf: (i) => i.t,
        });
        seen.push(...r.items.map((i) => i.id));
        cursor = r.nextCursor;
      } while (cursor && ++guard < 50);
      const expected = [...build().stratify!.flat(), ...build().prime!.flat()]
        .sort((a, b) => b.t - a.t)
        .map((i) => i.id);
      expect(new Set(seen).size).toBe(18);
      expect([...seen].sort()).toEqual([...expected].sort());
      expect(seen).toEqual(expected);
    });
  }
  it('keeps global order across pages when one account returns short pages', async () => {
    // stratify: newest items, but only 2 per page; prime: older items, full pages
    const data: Record<string, Item[][]> = {
      stratify: [
        [{ id: 's0', t: 100 }, { id: 's1', t: 99 }],
        [{ id: 's2', t: 98 }, { id: 's3', t: 97 }],
        [{ id: 's4', t: 96 }, { id: 's5', t: 95 }],
      ],
      prime: [
        [{ id: 'p0', t: 94 }, { id: 'p1', t: 93 }, { id: 'p2', t: 92 }, { id: 'p3', t: 91 }, { id: 'p4', t: 90 }],
        [{ id: 'p5', t: 89 }, { id: 'p6', t: 88 }],
      ],
    };
    const engine = engineFor([stratify, prime]);
    const fetch = pagedFetcher(data);
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const r = await engine.read({ selector: undefined, page: { pageSize: 5, cursor }, fetch, dateOf: (i) => i.t });
      seen.push(...r.items.map((i) => i.id));
      cursor = r.nextCursor;
    } while (cursor && ++guard < 20);
    const expected = [...data.stratify!.flat(), ...data.prime!.flat()].sort((a, b) => b.t - a.t).map((i) => i.id);
    expect(seen).toEqual(expected);
  });
  it('caps extra fetches at 3 per account per call', async () => {
    // stratify has 10 one-item pages, all newer than prime's single page
    const stratPages: Item[][] = Array.from({ length: 10 }, (_, k) => [{ id: `s${k}`, t: 1000 - k }]);
    const fetch = pagedFetcher({ stratify: stratPages, prime: [[{ id: 'p0', t: 1 }]] });
    const r = await engineFor([stratify, prime]).read({
      selector: undefined,
      page: { pageSize: 8 },
      fetch,
      dateOf: (i) => i.t,
    });
    expect(fetch.mock.calls.filter((c) => c[0].label === 'stratify')).toHaveLength(4); // 1 + 3 extra
    expect(r.items.map((i) => i.id)).toEqual(['s0', 's1', 's2', 's3', 'p0']);
    expect(decodeCursor(r.nextCursor!, SECRET)).toEqual({ stratify: { pageToken: '4', offset: 0 } });
  });
  it('throws a programmer error when dedupeKey is set without idOf', async () => {
    await expect(
      engineFor([stratify]).read({
        selector: undefined,
        page: { pageSize: 5 },
        fetch: pagedFetcher({}),
        dateOf: (i: Item) => i.t,
        dedupeKey: (i) => i.key,
      }),
    ).rejects.toThrow(/idOf is required/);
  });
  it('counts collapsed copies as consumed', async () => {
    const data: Record<string, Item[][]> = {
      stratify: [[{ id: 'a', t: 9, key: 'k' }, { id: 'b', t: 5, key: 'b' }], [{ id: 'c', t: 2, key: 'c' }]],
      prime: [[{ id: 'a2', t: 9, key: 'k' }, { id: 'd', t: 4, key: 'd' }]],
    };
    const engine = engineFor([stratify, prime]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await engine.read({
        selector: undefined,
        page: { pageSize: 1, cursor },
        fetch: pagedFetcher(data),
        dateOf: (i) => i.t,
        dedupeKey: (i) => i.key,
        idOf: (i) => ({ id: i.id }),
      });
      seen.push(...r.items.map((i) => i.id));
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['a', 'b', 'd', 'c']);
  });
  it('rejects a cursor with accounts outside the selector', async () => {
    const engine = engineFor([stratify, prime]);
    const cursor = encodeCursor({ prime: { offset: 0 } }, SECRET);
    await expect(
      engine.read({
        selector: 'stratify',
        page: { pageSize: 5, cursor },
        fetch: pagedFetcher({}),
        dateOf: (i: Item) => i.t,
      }),
    ).rejects.toThrow(AccountSelectionError);
  });
  it('rejects a tampered cursor cleanly', async () => {
    await expect(
      engineFor([stratify]).read({
        selector: undefined,
        page: { pageSize: 5, cursor: 'bogus.value' },
        fetch: pagedFetcher({}),
        dateOf: (i: Item) => i.t,
      }),
    ).rejects.toThrow(/invalid/);
  });
  it('only calls accounts in the cursor and keeps errored accounts in it', async () => {
    const engine = engineFor([stratify, prime]);
    const fetch = vi.fn(async (a: Account): Promise<AccountPage<Item>> => {
      if (a.label === 'prime') throw new ProviderError('rate_limited', 'x');
      return { items: [{ id: 's', t: 1 }] };
    });
    const r = await engine.read({ selector: undefined, page: { pageSize: 5 }, fetch, dateOf: (i) => i.t });
    expect(r.nextCursor).toBeDefined();
    expect(decodeCursor(r.nextCursor!, SECRET)).toEqual({ prime: { offset: 0 } });
    fetch.mockClear();
    await engine.read({ selector: undefined, page: { pageSize: 5, cursor: r.nextCursor }, fetch, dateOf: (i) => i.t });
    expect(fetch.mock.calls.map((c) => c[0].label)).toEqual(['prime']);
  });
});

describe('read: partial failures', () => {
  const okFetch = (a: Account) => Promise.resolve<AccountPage<Item>>({ items: [{ id: a.label, t: 1 }] });
  const run = (bad: (a: Account) => Promise<AccountPage<Item>>, accts = [stratify, prime], timeoutMs?: number) =>
    engineFor(accts).read({
      selector: undefined,
      page: { pageSize: 5 },
      fetch: (a) => (a.label === 'prime' ? bad(a) : okFetch(a)),
      dateOf: (i) => i.t,
      timeoutMs,
    });

  it('needs_reconnect', async () => {
    const r = await run(() => Promise.reject(new ProviderError('needs_reconnect', 'invalid_grant')));
    expect(r.items.map((i) => i.id)).toEqual(['stratify']);
    expect(r.accountErrors).toEqual([
      {
        account: 'prime',
        accountEmail: 'prime@example.com',
        kind: 'needs_reconnect',
        message: 'PRIME account disconnected — reconnect at /connect',
        action: '/connect',
      },
    ]);
  });
  it('rate_limited', async () => {
    const r = await run(() => Promise.reject(new ProviderError('rate_limited', 'x', 429)));
    expect(r.items).toHaveLength(1);
    expect(r.accountErrors).toHaveLength(1);
    expect(r.accountErrors[0]).toMatchObject({ kind: 'rate_limited' });
    expect(r.accountErrors[0]!.message).toBe('PRIME account was rate limited by Google; try again shortly');
  });
  it('missing_scope points to reconnect', async () => {
    const r = await run(() => Promise.reject(new ProviderError('missing_scope', 'x')));
    expect(r.accountErrors[0]).toMatchObject({ kind: 'missing_scope', action: '/connect' });
    expect(r.accountErrors[0]!.message).toContain('missing access to this product');
  });
  it('generic error does not leak its message', async () => {
    const r = await run(() => Promise.reject(new Error('SECRET body: hunter2')));
    expect(r.items).toHaveLength(1);
    expect(r.accountErrors).toHaveLength(1);
    expect(r.accountErrors[0]!.kind).toBe('upstream_error');
    expect(JSON.stringify(r.accountErrors)).not.toContain('hunter2');
  });
  it('timeout', async () => {
    const r = await run(() => new Promise(() => {}), [stratify, prime], 20);
    expect(r.items.map((i) => i.id)).toEqual(['stratify']);
    expect(r.accountErrors[0]).toMatchObject({ account: 'prime', kind: 'timeout' });
    expect(r.accountErrors[0]!.message).toContain('timed out after');
  });
  it('timeout with fake timers reports 15s by default', async () => {
    vi.useFakeTimers();
    try {
      const p = run(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(15001);
      const r = await p;
      expect(r.accountErrors[0]!.message).toBe(
        'PRIME account timed out after 15s; results from other accounts are shown',
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not call accounts already needs_reconnect', async () => {
    const dead = mk('prime', 1, 'needs_reconnect');
    const fetch = vi.fn((a: Account) => okFetch(a));
    const r = await engineFor([stratify, dead]).read({
      selector: undefined,
      page: { pageSize: 5 },
      fetch,
      dateOf: (i) => i.t,
    });
    expect(fetch.mock.calls.map((c) => c[0].label)).toEqual(['stratify']);
    expect(r.accountErrors).toHaveLength(1);
    expect(r.accountErrors[0]).toMatchObject({ kind: 'needs_reconnect', action: '/connect' });
  });
});

describe('lookup', () => {
  const engine = engineFor([prime, stratify]);
  it('first hit wins in priority order', async () => {
    const calls: string[] = [];
    const r = await engine.lookup(undefined, async (a) => {
      calls.push(a.label);
      return { id: a.label };
    });
    expect(calls).toEqual(['stratify']);
    expect(r.item).toMatchObject({ id: 'stratify', account: 'stratify', accountEmail: 'stratify@example.com' });
  });
  it('not_found misses and nulls are not errors', async () => {
    const r = await engine.lookup(undefined, async (a) => {
      if (a.label === 'stratify') throw new ProviderError('not_found', 'nope', 404);
      return { id: 'x' };
    });
    expect(r.item).toMatchObject({ account: 'prime' });
    expect(r.accountErrors).toEqual([]);
    const none = await engine.lookup(undefined, async () => null);
    expect(none).toEqual({ item: null, accountErrors: [] });
  });
  it('reports an error on the first account but returns the second hit', async () => {
    const r = await engine.lookup(undefined, async (a) => {
      if (a.label === 'stratify') throw new ProviderError('rate_limited', 'x');
      return { id: 'x' };
    });
    expect(r.item).toMatchObject({ account: 'prime' });
    expect(r.accountErrors).toHaveLength(1);
    expect(r.accountErrors[0]).toMatchObject({ account: 'stratify', kind: 'rate_limited' });
  });
  it('skips needs_reconnect accounts with an error', async () => {
    const e = engineFor([mk('stratify', 0, 'needs_reconnect'), prime]);
    const fn = vi.fn(async () => ({ id: 'x' }));
    const r = await e.lookup(undefined, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.accountErrors[0]).toMatchObject({ account: 'stratify', kind: 'needs_reconnect' });
  });
});

describe('resolveWriteAccount', () => {
  const engine = engineFor([prime, stratify]);
  it('single account by label, email or one-item list', async () => {
    expect((await engine.resolveWriteAccount('prime')).label).toBe('prime');
    expect((await engine.resolveWriteAccount('stratify@example.com')).label).toBe('stratify');
    expect((await engine.resolveWriteAccount(['prime'])).label).toBe('prime');
  });
  it('rejects all and multiple accounts', async () => {
    const msg = 'Writes need exactly one account. Which one: stratify or prime?';
    await expect(engine.resolveWriteAccount('all')).rejects.toThrow(msg);
    await expect(engine.resolveWriteAccount(['prime', 'stratify'])).rejects.toThrow(AccountSelectionError);
  });
  it('undefined uses the fallback, otherwise asks which', async () => {
    expect((await engine.resolveWriteAccount(undefined, async () => prime)).label).toBe('prime');
    await expect(engine.resolveWriteAccount(undefined)).rejects.toThrow(/Which one/);
    await expect(engine.resolveWriteAccount(undefined, async () => null)).rejects.toThrow(/Which one/);
  });
  it('rejects needs_reconnect accounts', async () => {
    const e = engineFor([stratify, mk('prime', 1, 'needs_reconnect')]);
    await expect(e.resolveWriteAccount('prime')).rejects.toMatchObject({ kind: 'needs_reconnect' });
    await expect(e.resolveWriteAccount(undefined, async () => mk('prime', 1, 'needs_reconnect'))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
