import type { Account, AccountError, AccountSelector, Tagged } from './contracts/account';
import type { AccountPage, FanOutEngine, FanOutReadResult, FanOutReadSpec } from './contracts/fanout';
import { byPriority, resolveAccounts } from './accounts';
import { decodeCursor, encodeCursor, type CursorState } from './cursor';
import { AccountSelectionError, ProviderError } from './errors';

export interface FanOutOptions {
  listAccounts: () => Promise<Account[]>;
  cursorSecret: string;
  reconnectUrl: string;
}

const DEFAULT_TIMEOUT_MS = 15000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

interface Entry<T> {
  item: T;
  account: Account;
  order: number;
  idx: number;
}
interface Group<T> {
  rep: Entry<T>;
  members: Entry<T>[];
}
interface AcctState<T> {
  a: Account;
  order: number;
  st: CursorState[string];
  pages: { token: string | undefined; page: AccountPage<T> }[];
  extra: number;
  stopped: boolean;
}

const MAX_EXTRA_FETCHES = 3;

export function createFanOutEngine(opts: FanOutOptions): FanOutEngine {
  const { listAccounts, cursorSecret, reconnectUrl } = opts;

  const disconnected = (a: Account): AccountError => ({
    account: a.label,
    accountEmail: a.email,
    kind: 'needs_reconnect',
    message: `${a.label.toUpperCase()} account disconnected — reconnect at ${reconnectUrl}`,
    action: reconnectUrl,
  });

  function toError(a: Account, err: unknown, timeoutMs: number): AccountError {
    const L = a.label.toUpperCase();
    const base = { account: a.label, accountEmail: a.email };
    if (err instanceof TimeoutError) {
      return {
        ...base,
        kind: 'timeout',
        message: `${L} account timed out after ${Math.round(timeoutMs / 1000)}s; results from other accounts are shown`,
      };
    }
    if (err instanceof ProviderError) {
      switch (err.kind) {
        case 'needs_reconnect':
          return disconnected(a);
        case 'missing_scope':
          return {
            ...base,
            kind: 'missing_scope',
            message: `${L} account is missing access to this product — reconnect at ${reconnectUrl}`,
            action: reconnectUrl,
          };
        case 'rate_limited':
          return { ...base, kind: 'rate_limited', message: `${L} account was rate limited by Google; try again shortly` };
        default:
          return { ...base, kind: err.kind, message: `${L} account: ${err.message}` };
      }
    }
    return {
      ...base,
      kind: 'upstream_error',
      message: `${L} account had an unexpected error; results from other accounts are shown`,
    };
  }

  async function read<T>(spec: FanOutReadSpec<T>): Promise<FanOutReadResult<T>> {
    if (spec.dedupeKey && !spec.idOf) {
      throw new Error('FanOutReadSpec.idOf is required when dedupeKey is set (programmer error).');
    }
    const resolved = resolveAccounts(spec.selector, await listAccounts());
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pageSize = spec.page.pageSize;

    let cursorState: CursorState | undefined;
    let targets = resolved;
    if (spec.page.cursor) {
      const state = decodeCursor(spec.page.cursor, cursorSecret);
      cursorState = state;
      const labels = new Set(resolved.map((a) => a.label));
      const outside = Object.keys(state).filter((l) => !labels.has(l));
      if (outside.length > 0) {
        throw new AccountSelectionError(
          `The paging cursor includes accounts outside this request (${outside.join(', ')}). Repeat the request with the same account argument, or start again without a cursor.`,
          resolved.map((a) => a.label),
        );
      }
      targets = resolved.filter((a) => a.label in state);
    }

    const errorsByOrder: { order: number; seq: number; error: AccountError }[] = [];
    const addError = (order: number, error: AccountError) =>
      errorsByOrder.push({ order, seq: errorsByOrder.length, error });
    const nextState: CursorState = {};

    const fetchPage = (a: Account, token: string | undefined) =>
      withTimeout(Promise.resolve().then(() => spec.fetch(a, token, pageSize)), timeoutMs);

    const live: AcctState<T>[] = [];
    await Promise.all(
      targets.map(async (a, order) => {
        const st = cursorState?.[a.label] ?? { offset: 0 };
        if (a.status === 'needs_reconnect') {
          addError(order, disconnected(a));
          nextState[a.label] = st;
          return;
        }
        try {
          const page = await fetchPage(a, st.pageToken);
          live.push({ a, order, st, pages: [{ token: st.pageToken, page }], extra: 0, stopped: false });
        } catch (err) {
          addError(order, toError(a, err, timeoutMs));
          nextState[a.label] = st; // keep old position so the next page retries it
        }
      }),
    );
    live.sort((x, y) => x.order - y.order);

    const poolOf = (s: AcctState<T>): T[] =>
      s.pages.flatMap((p, k) => (k === 0 ? p.page.items.slice(s.st.offset) : p.page.items));

    let taken: Group<T>[] = [];
    let consumed = new Map<string, number>();
    for (;;) {
      const entries: Entry<T>[] = [];
      for (const s of live) poolOf(s).forEach((item, idx) => entries.push({ item, account: s.a, order: s.order, idx }));
      entries.sort((x, y) => spec.dateOf(y.item) - spec.dateOf(x.item) || x.order - y.order || x.idx - y.idx);

      const groups: Group<T>[] = [];
      const byKey = new Map<string, Group<T>>();
      for (const e of entries) {
        const key = spec.dedupeKey?.(e.item);
        const existing = key === undefined ? undefined : byKey.get(key);
        if (existing) {
          existing.members.push(e);
          if (e.order < existing.rep.order) existing.rep = e;
        } else {
          const g: Group<T> = { rep: e, members: [e] };
          groups.push(g);
          if (key !== undefined) byKey.set(key, g);
        }
      }
      taken = groups.slice(0, pageSize);
      consumed = new Map<string, number>();
      for (const g of taken) {
        for (const m of g.members) consumed.set(m.account.label, (consumed.get(m.account.label) ?? 0) + 1);
      }

      // An account whose whole pool was consumed may hold newer items on its next page than the
      // oldest item in the cut (or the cut is short). Fetch it, then merge and cut again.
      const full = taken.length >= pageSize;
      const cutDate = full ? spec.dateOf(taken[taken.length - 1]!.rep.item) : -Infinity;
      const needMore = live.filter((s) => {
        if (s.stopped || s.extra >= MAX_EXTRA_FETCHES) return false;
        if (!s.pages[s.pages.length - 1]!.page.nextPageToken) return false;
        const pool = poolOf(s);
        if ((consumed.get(s.a.label) ?? 0) < pool.length) return false;
        if (!full || pool.length === 0) return true;
        return spec.dateOf(pool[pool.length - 1]!) >= cutDate;
      });
      if (needMore.length === 0) break;
      await Promise.all(
        needMore.map(async (s) => {
          s.extra += 1;
          const token = s.pages[s.pages.length - 1]!.page.nextPageToken;
          try {
            s.pages.push({ token, page: await fetchPage(s.a, token) });
          } catch (err) {
            addError(s.order, toError(s.a, err, timeoutMs));
            s.stopped = true; // cursor resumes at the failed page, so the next call retries it
          }
        }),
      );
    }

    // Next cursor: resume each account at the page holding its first unconsumed item.
    for (const s of live) {
      let remaining = consumed.get(s.a.label) ?? 0;
      let resumed = false;
      for (let k = 0; k < s.pages.length && !resumed; k++) {
        const p = s.pages[k]!;
        const usable = k === 0 ? Math.max(p.page.items.length - s.st.offset, 0) : p.page.items.length;
        if (remaining < usable) {
          const offset = (k === 0 ? s.st.offset : 0) + remaining;
          nextState[s.a.label] = p.token ? { pageToken: p.token, offset } : { offset };
          resumed = true;
        } else {
          remaining -= usable;
        }
      }
      if (!resumed) {
        const token = s.pages[s.pages.length - 1]!.page.nextPageToken;
        if (token) nextState[s.a.label] = { pageToken: token, offset: 0 };
      }
    }

    const dedupe = spec.dedupeKey !== undefined;
    const items = taken.map((g) => {
      const tagged = { ...g.rep.item, account: g.rep.account.label, accountEmail: g.rep.account.email } as Tagged<T>;
      if (!dedupe) return tagged;
      const members = [...g.members].sort((a, b) => a.order - b.order);
      const sources = members.map((m) => {
        const native = spec.idOf!(m.item);
        return {
          account: m.account.label,
          id: native.id,
          ...(native.calendarId !== undefined ? { calendarId: native.calendarId } : {}),
        };
      });
      return { ...tagged, accounts: members.map((m) => m.account.label), sources };
    });

    const accountErrors = errorsByOrder.sort((x, y) => x.order - y.order || x.seq - y.seq).map((e) => e.error);
    const result: FanOutReadResult<T> = { items, accountErrors };
    if (Object.keys(nextState).length > 0) result.nextCursor = encodeCursor(nextState, cursorSecret);
    return result;
  }

  async function lookup<T>(
    selector: AccountSelector,
    fn: (a: Account) => Promise<T | null>,
  ): Promise<{ item: Tagged<T> | null; accountErrors: AccountError[] }> {
    const accounts = resolveAccounts(selector, await listAccounts());
    const accountErrors: AccountError[] = [];
    for (const a of accounts) {
      if (a.status === 'needs_reconnect') {
        accountErrors.push(disconnected(a));
        continue;
      }
      try {
        const hit = await fn(a);
        if (hit !== null && hit !== undefined) {
          return { item: { ...hit, account: a.label, accountEmail: a.email } as Tagged<T>, accountErrors };
        }
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') continue;
        accountErrors.push(toError(a, err, DEFAULT_TIMEOUT_MS));
      }
    }
    return { item: null, accountErrors };
  }

  async function resolveWriteAccount(
    selector: AccountSelector,
    fallback?: () => Promise<Account | null>,
  ): Promise<Account> {
    const all = byPriority(await listAccounts());
    const which = () =>
      new AccountSelectionError(
        `Writes need exactly one account. Which one: ${all.map((a) => a.label).join(' or ')}?`,
        all.map((a) => a.label),
      );
    let account: Account | null | undefined;
    if (selector === undefined) {
      account = fallback ? await fallback() : null;
    } else {
      const resolved = resolveAccounts(selector, all);
      if (resolved.length !== 1) throw which();
      account = resolved[0];
    }
    if (!account) throw which();
    if (account.status === 'needs_reconnect') {
      throw new ProviderError(
        'needs_reconnect',
        `${account.label.toUpperCase()} account disconnected — reconnect at ${reconnectUrl}`,
      );
    }
    return account;
  }

  return { read, lookup, resolveWriteAccount };
}
