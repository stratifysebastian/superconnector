import type { Account } from './account';
import type { CalendarAdapter } from './calendar';

/**
 * Everything an adapter needs to make one call for one account. Adapters never hold an access token:
 * `http` is bound to the account's token and attaches it itself.
 */
export interface AdapterContext {
  account: Account;
  /**
   * The only way to reach Google. Deny by default: every request is checked against the endpoint rules
   * (src/google/endpoints) before anything is fetched, then sent with auth, 429 backoff with jitter
   * (max 3 retries), timeout and a structured log.
   */
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
// Note: GoogleHttp has no delete verb by design. No adapter can issue one.

/** One adapter per product. Live and mock implementations satisfy the same interface; GOOGLE_MODE picks one. */
export interface AdapterFactory {
  calendar(ctx: AdapterContext): CalendarAdapter;
}
