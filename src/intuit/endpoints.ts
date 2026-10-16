/**
 * The only place under src/ that names QuickBooks API hosts and paths. IntuitHttp checks every request against
 * INTUIT_RULES before anything is fetched: deny by default, one row per allowed call.
 * Q0 has exactly one row (CompanyInfo). Later phases add their own rows here.
 */

export type IntuitEnv = 'production' | 'sandbox';

export const INTUIT_LIVE_HOST = 'quickbooks.api.intuit.com';
export const INTUIT_SANDBOX_HOST = 'sandbox-quickbooks.api.intuit.com';

/** A recent stable minor version, always sent so response shapes do not drift. */
export const INTUIT_MINOR_VERSION = '75';

export const REALM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The one host for this environment. The sandbox host is never allowed in production, nor the live host in sandbox. */
export const intuitHostFor = (env: IntuitEnv): string => (env === 'sandbox' ? INTUIT_SANDBOX_HOST : INTUIT_LIVE_HOST);

/** Adapters build paths with this; `rest` is what follows `/v3/company/{realmId}/`. */
export const companyPath = (realmId: string, rest: string): string => `/v3/company/${realmId}/${rest}`;

export interface IntuitRule {
  id: string;
  method: 'GET';
  /** Logged instead of the real path. */
  template: string;
  /** Anchored; matched against the part after `/v3/company/{realmId}/`. Given the account's realmId. */
  rest: (realmId: string) => RegExp;
  /** Required. An empty array means no query keys are allowed. `minorversion` is added by IntuitHttp, never by callers. */
  allowedQuery: string[];
}

export const INTUIT_RULES: IntuitRule[] = [
  {
    id: 'qbo.companyinfo.get',
    method: 'GET',
    template: '/v3/company/{realmId}/companyinfo/{realmId}',
    rest: (realmId) => new RegExp(`^companyinfo/${realmId}$`),
    allowedQuery: [],
  },
];

export interface IntuitPolicyRequest {
  method: unknown;
  /** Host IntuitHttp is about to use. */
  host: unknown;
  /** Absolute path, no query string. */
  path: unknown;
  query?: Record<string, string>;
  /** The account's own realmId, from the stored account (never caller input). */
  realmId: string;
  env: IntuitEnv;
}

export type IntuitPolicyResult = { ok: true; rule: IntuitRule } | { ok: false; reason: string; rule: string };

const deny = (rule: string, reason: string): IntuitPolicyResult => ({ ok: false, rule, reason: `${rule}: ${reason}` });

export function checkIntuitRequest(rules: readonly IntuitRule[], req: IntuitPolicyRequest): IntuitPolicyResult {
  if (req.method !== 'GET') return deny('method', 'HTTP method not allowed');
  if (!REALM_ID_PATTERN.test(req.realmId)) return deny('realm/invalid', 'the account has no valid realmId');
  if (req.host !== intuitHostFor(req.env)) return deny('url/host', 'host is not allowed for this environment');
  const path = req.path;
  if (typeof path !== 'string') return deny('url/type', 'path must be a string');
  // Letters, digits and a few separators only: no dots, percent-escapes, backslashes, query or fragment.
  if (!/^\/[A-Za-z0-9_\-/]*$/.test(path) || path.includes('//')) return deny('url/path-trickery', 'path has characters that are not allowed');
  const prefix = '/v3/company/';
  if (!path.startsWith(prefix)) return deny('path/prefix', 'path must start with /v3/company/{realmId}/');
  const after = path.slice(prefix.length);
  const slash = after.indexOf('/');
  const realmInPath = slash < 0 ? after : after.slice(0, slash);
  if (realmInPath !== req.realmId) return deny('path/realm', "path names a company other than the account's own");
  const rest = slash < 0 ? '' : after.slice(slash + 1);

  const rule = rules.find((r) => r.method === 'GET' && r.rest(req.realmId).test(rest));
  if (!rule) return deny('no-matching-rule', 'GET on this company path matches no endpoint rule');
  const allowed = new Set(rule.allowedQuery);
  for (const k of Object.keys(req.query ?? {})) {
    if (!allowed.has(k)) return deny(rule.id, `query key "${k}" is not allowed`);
  }
  return { ok: true, rule };
}
