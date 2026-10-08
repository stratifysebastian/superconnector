export type Provider = 'google' | 'microsoft';
export type AccountStatus = 'active' | 'needs_reconnect';
export type Product = 'calendar' | 'gmail' | 'drive' | 'docs' | 'sheets' | 'slides';

export interface Account {
  id: string; // uuid
  provider: Provider;
  email: string;
  label: string; // 'stratify', 'prime'
  orgClientId: string;
  priority: number; // lower = earlier; Stratify = 0
  connectedAt: string; // ISO
  status: AccountStatus;
  grantedScopes: string[];
}

/** Tool argument: label, email, list of either, or 'all'. Omitted = 'all' for reads. */
export type AccountSelector = string | string[] | 'all' | undefined;

export type AccountErrorKind =
  | 'needs_reconnect' // invalid_grant
  | 'missing_scope'
  | 'rate_limited' // 429 after retries
  | 'timeout'
  | 'not_found'
  | 'upstream_error';

export interface AccountError {
  account: string; // label
  accountEmail: string;
  kind: AccountErrorKind;
  message: string; // plain language, e.g. "PR1ME account disconnected — reconnect at /connect"
  action?: string; // e.g. reconnect URL
}

/** Every item returned from a fan-out read. */
export type Tagged<T> = T & { account: string; accountEmail: string };
/** De-duplicated items (calendar events, drive files) also carry this. */
export interface MultiSource {
  accounts: string[]; // labels, priority order
  sources: { account: string; id: string; calendarId?: string }[];
}
