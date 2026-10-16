/**
 * The only place under src/ that names QuickBooks API hosts and paths. IntuitHttp checks every request against
 * INTUIT_RULES before anything is fetched: deny by default, one row per allowed call.
 * Q1: CompanyInfo, the query endpoint, nine reports, and the Item and Customer creates (the only writes).
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
  method: 'GET' | 'POST';
  /** Logged instead of the real path. */
  template: string;
  /** What the call does, in words, for the plain error message ("create a customer"). */
  label: string;
  /** Anchored; matched against the part after `/v3/company/{realmId}/`. Given the account's realmId. */
  rest: (realmId: string) => RegExp;
  /** Required. An empty array means no query keys are allowed. `minorversion` is added by IntuitHttp, never by callers. */
  allowedQuery: string[];
  /** POST only: the top-level body keys that may be sent. A POST rule without this list denies every body. */
  bodyKeys?: string[];
  /** Extra check on the query values. Returns a reason to deny, or null. */
  checkQuery?: (query: Record<string, string>) => string | null;
}

/** Reports API parameters. Each report lists exactly the ones its tools send. */
const PERIOD_PARAMS = ['date_macro', 'start_date', 'end_date', 'accounting_method', 'summarize_column_by'];
const AGING_PARAMS = ['report_date'];
const REPORTS: [name: string, params: string[]][] = [
  ['BalanceSheet', PERIOD_PARAMS],
  ['ProfitAndLoss', PERIOD_PARAMS],
  ['CashFlow', PERIOD_PARAMS],
  ['AgedReceivables', AGING_PARAMS],
  ['AgedReceivableDetail', AGING_PARAMS],
  ['AgedPayables', AGING_PARAMS],
  ['AgedPayableDetail', AGING_PARAMS],
  ['CustomerSales', PERIOD_PARAMS],
  ['ItemSales', PERIOD_PARAMS],
];

/**
 * The query endpoint takes our own `select ... from <entity> ...` text and nothing else. Only these entities may be read
 * this way. The text is built by src/intuit/query.ts with escaped values; tool input never reaches it unescaped.
 */
const QUERY_SHAPE = /^select [\w*.,() ]{1,200} from (?:Item|Customer|Account)\b[^\n\r]*$/i;
const checkQuery = (q: Record<string, string>): string | null => {
  const text = q.query;
  if (typeof text !== 'string' || text.length > 2000 || !QUERY_SHAPE.test(text)) return 'query text is not a select on Item, Customer or Account';
  return null;
};

export const INTUIT_RULES: IntuitRule[] = [
  {
    id: 'qbo.companyinfo.get',
    method: 'GET',
    template: '/v3/company/{realmId}/companyinfo/{realmId}',
    label: 'read the company information',
    rest: (realmId) => new RegExp(`^companyinfo/${realmId}$`),
    allowedQuery: [],
  },
  {
    id: 'qbo.query.get',
    method: 'GET',
    template: '/v3/company/{realmId}/query',
    label: 'look up records',
    rest: () => /^query$/,
    allowedQuery: ['query'],
    checkQuery,
  },
  ...REPORTS.map(
    ([name, params]): IntuitRule => ({
      id: `qbo.report.${name}.get`,
      method: 'GET',
      template: `/v3/company/{realmId}/reports/${name}`,
      label: 'run the report',
      rest: () => new RegExp(`^reports/${name}$`),
      allowedQuery: params,
    }),
  ),
  {
    id: 'qbo.item.create',
    method: 'POST',
    template: '/v3/company/{realmId}/item',
    label: 'create the product or service',
    rest: () => /^item$/,
    allowedQuery: [],
    bodyKeys: ['Name', 'Type', 'UnitPrice', 'Description', 'Sku', 'Taxable', 'TrackQtyOnHand', 'QtyOnHand', 'InvStartDate', 'IncomeAccountRef', 'AssetAccountRef', 'ExpenseAccountRef'],
  },
  {
    id: 'qbo.customer.create',
    method: 'POST',
    template: '/v3/company/{realmId}/customer',
    label: 'create the customer',
    rest: () => /^customer$/,
    allowedQuery: [],
    bodyKeys: ['DisplayName', 'GivenName', 'FamilyName', 'CompanyName', 'PrimaryEmailAddr', 'PrimaryPhone', 'BillAddr', 'ShipAddr'],
  },
];

export interface IntuitPolicyRequest {
  method: unknown;
  /** Host IntuitHttp is about to use. */
  host: unknown;
  /** Absolute path, no query string. */
  path: unknown;
  query?: Record<string, string>;
  /** POST only. */
  body?: unknown;
  /** The account's own realmId, from the stored account (never caller input). */
  realmId: string;
  env: IntuitEnv;
}

export type IntuitPolicyResult = { ok: true; rule: IntuitRule } | { ok: false; reason: string; rule: string };

const deny = (rule: string, reason: string): IntuitPolicyResult => ({ ok: false, rule, reason: `${rule}: ${reason}` });

export function checkIntuitRequest(rules: readonly IntuitRule[], req: IntuitPolicyRequest): IntuitPolicyResult {
  if (req.method !== 'GET' && req.method !== 'POST') return deny('method', 'HTTP method not allowed');
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

  const rule = rules.find((r) => r.method === req.method && r.rest(req.realmId).test(rest));
  if (!rule) return deny('no-matching-rule', `${req.method} on this company path matches no endpoint rule`);
  const allowed = new Set(rule.allowedQuery);
  for (const k of Object.keys(req.query ?? {})) {
    if (!allowed.has(k)) return deny(rule.id, `query key "${k}" is not allowed`);
  }
  const bad = rule.checkQuery?.(req.query ?? {});
  if (bad) return deny(rule.id, bad);
  if (rule.method === 'GET') {
    if (req.body !== undefined) return deny(rule.id, 'a GET has no body');
  } else {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return deny(rule.id, 'body must be a plain object');
    const keys = new Set(rule.bodyKeys ?? []);
    for (const k of Object.keys(body)) if (!keys.has(k)) return deny(rule.id, `body key "${k}" is not allowed`);
  }
  return { ok: true, rule };
}
