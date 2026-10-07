import type { Account } from './account';

/** Everything an adapter needs to make one call for one account. */
export interface AdapterContext {
  account: Account;
  /** Returns a fresh access token. Throws GoogleAuthError('invalid_grant') → account marked needs_reconnect. */
  getAccessToken(): Promise<string>;
  /** fetch wrapper: auth header, 429 backoff with jitter (max 3 retries), timeout, structured log. */
  http: GoogleHttp;
  signal: AbortSignal;
}

export interface GoogleHttp {
  json<T>(req: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    url: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }): Promise<T>;
}
// Note: no 'DELETE' method exists on GoogleHttp. No adapter can issue one.

/** Each product adds its own interface in its phase, e.g. CalendarAdapter in Phase 1.
 *  Live and mock implementations satisfy the same interface; GOOGLE_MODE picks one. */
export interface AdapterFactory {
  calendar(ctx: AdapterContext): unknown; // narrowed to CalendarAdapter in Phase 1, etc.
}
