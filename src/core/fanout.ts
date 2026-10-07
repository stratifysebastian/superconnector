import type { Account, AccountError, AccountSelector, Tagged } from './contracts/account';
import type { AccountPage, FanOutEngine, FanOutReadResult, FanOutReadSpec } from './contracts/fanout';
import { byPriority, resolveAccounts } from './accounts';
import { decodeCursor, encodeCursor, type CursorState } from './cursor';
import { AccountSelectionError, ProviderError } from './errors';

export interface FanOutOptions {
  listAccounts: () => Promise<Account[]>;
  cursorSecret: string;
  reconnectUrl: string;
  now?: () => number;
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
type Outcome<T> =
  | { a: Account; order: number; st: CursorState[string]; error: AccountError }
  | { a: Account; order: number; st: CursorState[string]; page: AccountPage<T> };

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

    const accountErrors: AccountError[] = [];
    const nextState: CursorState = {};
    const entries: Entry<T>[] = [];
    const fetchedCount = new Map<string, number>();
    const nextTokens = new Map<string, string | undefined>();

    const outcomes: Outcome<T>[] = await Promise.all(
      targets.map(async (a, order): Promise<Outcome<T>> => {
        const st = cursorState?.[a.label] ?? { offset: 0 };
        if (a.status === 'needs_reconnect') return { a, order, st, error: disconnected(a) };
        try {
          const page = await withTimeout(
            Promise.resolve().then(() => spec.fetch(a, st.pageToken, pageSize)),
            timeoutMs,
          );
          return { a, order, st, page };
        } catch (err) {
          return { a, order, st, error: toError(a, err, timeoutMs) };
        }
      }),
    );

    for (const o of outcomes) {
      if ('error' in o) {
        accountErrors.push(o.error);
        nextState[o.a.label] = o.st; // keep old position so the next page retries it
        continue;
      }
      const usable = o.page.items.slice(o.st.offset);
      fetchedCount.set(o.a.label, usable.length);
      nextTokens.set(o.a.label, o.page.nextPageToken);
      usable.forEach((item, idx) => entries.push({ item, account: o.a, order: o.order, idx }));
    }

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

    const taken = groups.slice(0, pageSize);
    const consumed = new Map<string, number>();
    for (const g of taken) {
      for (const m of g.members) consumed.set(m.account.label, (consumed.get(m.account.label) ?? 0) + 1);
    }

    for (const o of outcomes) {
      if ('error' in o) continue;
      const label = o.a.label;
      const used = consumed.get(label) ?? 0;
      if (used >= (fetchedCount.get(label) ?? 0)) {
        const token = nextTokens.get(label);
        if (token) nextState[label] = { pageToken: token, offset: 0 };
      } else {
        nextState[label] = o.st.pageToken
          ? { pageToken: o.st.pageToken, offset: o.st.offset + used }
          : { offset: o.st.offset + used };
      }
    }

    const dedupe = spec.dedupeKey !== undefined;
    const items = taken.map((g) => {
      const tagged = { ...g.rep.item, account: g.rep.account.label, accountEmail: g.rep.account.email } as Tagged<T>;
      if (!dedupe) return tagged;
      const members = [...g.members].sort((a, b) => a.order - b.order);
      const sources = members.map((m) => {
        const native = spec.idOf?.(m.item);
        return {
          account: m.account.label,
          id: native?.id ?? '',
          ...(native?.calendarId !== undefined ? { calendarId: native.calendarId } : {}),
        };
      });
      return { ...tagged, accounts: members.map((m) => m.account.label), sources };
    });

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
