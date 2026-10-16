import type { Account, AccountError, AccountSelector, Tagged, MultiSource } from './account';

export interface PageRequest {
  pageSize: number;
  cursor?: string;
}
export interface AccountPage<T> {
  items: T[];
  nextPageToken?: string;
}

export interface FanOutReadSpec<T> {
  selector: AccountSelector;
  page: PageRequest;
  /** Calls one account's adapter. Receives that account's own page token. */
  fetch: (account: Account, pageToken: string | undefined, pageSize: number) => Promise<AccountPage<T>>;
  /** Natural date of an item (ms epoch): message date, event start, modifiedTime. */
  dateOf: (item: T) => number;
  /** Optional de-dup key: `${iCalUID}|${start}` for events, file id for Drive. */
  dedupeKey?: (item: T) => string | undefined;
  /** Per-item native id, kept in `sources` when items collapse. */
  idOf?: (item: T) => { id: string; calendarId?: string };
  timeoutMs?: number; // default 15000
}

export interface FanOutReadResult<T> {
  items: Array<Tagged<T> & Partial<MultiSource>>; // newest first; ties by account priority
  nextCursor?: string; // opaque; encodes each account's page token
  accountErrors: AccountError[]; // never omitted; [] when clean
}

export interface FanOutEngine {
  read<T>(spec: FanOutReadSpec<T>): Promise<FanOutReadResult<T>>;
  /** Lookup by id: tries accounts in priority order and returns the first hit. */
  lookup<T>(
    selector: AccountSelector,
    fn: (a: Account) => Promise<T | null>,
  ): Promise<{ item: Tagged<T> | null; accountErrors: AccountError[] }>;
  /** Writes: exactly one account, or an error asking which one. Never fans out. */
  resolveWriteAccount(selector: AccountSelector, fallback?: () => Promise<Account | null>): Promise<Account>;
}
