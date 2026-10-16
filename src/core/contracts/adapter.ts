import type { Account } from './account';
import type { CalendarAdapter } from './calendar';
import type { DriveAdapter } from './drive';
import type { GmailAdapter } from './gmail';
import type { QuickBooksAdapter } from './quickbooks';

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
  /** POST multipart/related: a JSON metadata part (policy-checked like a body) plus raw content. */
  upload<T>(req: {
    url: string;
    query?: Record<string, string | number | boolean | undefined>;
    metadata: unknown;
    content: Uint8Array;
    contentType: string;
  }): Promise<T>;
  /** GET raw bytes. Fails without reading further once the response exceeds maxBytes. */
  download(req: {
    url: string;
    query?: Record<string, string | number | boolean | undefined>;
    maxBytes: number;
  }): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Sends one email from the account to the account itself, and nothing else: there is no recipient input.
   * GoogleHttp builds the message from its own account address and the policy re-checks it. This is the only send path.
   */
  sendToSelf(req: { subject: string; body: string; htmlBody?: string }): Promise<{ id: string; threadId?: string }>;
}
// Note: GoogleHttp has no delete verb by design. No adapter can issue one.

/** Same idea for QuickBooks: `http` is bound to the company's token and its own realmId. */
export interface QuickBooksAdapterContext {
  account: Account;
  http: IntuitHttp;
  signal: AbortSignal;
}

/**
 * The only way to reach QuickBooks. Deny by default (src/intuit/endpoints): every request must match a rule that names
 * its method, path, query keys and (for POST) body keys. A POST is never retried.
 */
export interface IntuitHttp {
  /** `path` starts with `/v3/company/{realmId}/`; the realmId must be the account's own or the request is denied. */
  json<T>(req: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    /** POST only; its top-level keys must be listed by the rule. */
    body?: Record<string, unknown>;
  }): Promise<T>;
}

/** One adapter per product. Live and mock implementations satisfy the same interface; GOOGLE_MODE picks one. */
export interface AdapterFactory {
  calendar(ctx: AdapterContext): CalendarAdapter;
  gmail(ctx: AdapterContext): GmailAdapter;
  drive(ctx: AdapterContext): DriveAdapter;
  quickbooks(ctx: QuickBooksAdapterContext): QuickBooksAdapter;
}
