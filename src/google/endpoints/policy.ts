import type { Product } from '@/core/contracts/account';
import { bodyBan, pathBan, queryBan } from './guards';
import { GOOGLE_API_HOSTS } from './urls';

export interface EndpointRule {
  id: string;
  product: Product;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  host: string;
  /** Anchored; matched against the normalised (still percent-encoded) pathname. */
  path: RegExp;
  /** Required. An empty array means no query keys are allowed. */
  allowedQuery: string[];
  requiredQuery?: Record<string, string>;
  /** Returns a violation reason, or null if the body is fine. */
  checkBody?: (body: unknown) => string | null;
}

/** Already-snapshotted request. `query` values are strings; `body` is plain parsed JSON (or undefined). */
export interface PolicyRequest {
  method: unknown;
  url: unknown;
  query?: Record<string, string>;
  body?: unknown;
}

export type PolicyResult = { ok: true } | { ok: false; reason: string; rule: string };

const METHODS = ['GET', 'POST', 'PATCH', 'PUT'];

const deny = (rule: string, reason: string): PolicyResult => ({ ok: false, rule, reason: `${rule}: ${reason}` });

/** Parse and validate the URL itself. Returns the URL or a denial. */
export function parseGoogleUrl(url: unknown): URL | PolicyResult {
  if (typeof url !== 'string') return deny('url/type', 'url must be a string');
  if (/[\u0000- \u007f]/.test(url)) return deny('url/control-chars', 'url contains whitespace or control characters');
  if (/[?#]/.test(url)) return deny('url/query-in-url', 'url must not contain "?" or "#"; pass query separately');
  if (/\.\.|%2e|%2f|%5c|%00|\\|\/\//i.test(url.replace(/^https:\/\//i, ''))) {
    return deny('url/path-trickery', 'url path contains "..", encoded dots/slashes, backslashes or empty segments');
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return deny('url/invalid', 'url is not parseable');
  }
  if (u.protocol !== 'https:') return deny('url/not-https', 'only https is allowed');
  if (u.username !== '' || u.password !== '') return deny('url/userinfo', 'userinfo in url is not allowed');
  if (u.port !== '') return deny('url/port', 'explicit ports are not allowed');
  if (!GOOGLE_API_HOSTS.includes(u.hostname)) return deny('url/host', `host "${u.hostname}" is not allowed`);
  return u;
}

/** Returns why a rule is malformed (unanchored or stateful regex, missing allowedQuery), or null. */
function badRule(r: EndpointRule): string | null {
  if (!(r?.path instanceof RegExp)) return 'path is not a RegExp';
  if (!Array.isArray(r.allowedQuery)) return 'allowedQuery must be an array';
  const { source, flags } = r.path;
  if (flags.includes('g') || flags.includes('y')) return 'path regex must not have the g or y flag';
  if (!source.startsWith('^')) return 'path regex must start with ^';
  if (!source.endsWith('$') || /(?:^|[^\\])(?:\\\\)*\\\$$/.test(source)) return 'path regex must end with an unescaped $';
  // A top-level alternation (^a|b$) is not anchored on every branch.
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return 'path regex has a top-level alternation';
  }
  return null;
}

/**
 * Deny by default: the request must satisfy the universal checks and the hard bans, then match a rule
 * on method + host + path, then that rule's query and body constraints.
 */
export function checkRequest(rules: readonly EndpointRule[], req: PolicyRequest): PolicyResult {
  const method = req.method;
  if (typeof method !== 'string' || !METHODS.includes(method)) return deny('method', 'HTTP method not allowed');
  const parsed = parseGoogleUrl(req.url);
  if (!(parsed instanceof URL)) return parsed;
  const query = req.query ?? {};
  const pathname = parsed.pathname;

  const q = queryBan(query);
  if (q) return deny(q.rule, q.reason);
  const p = pathBan(method, pathname, query);
  if (p) return deny(p.rule, p.reason);
  if (req.body !== undefined) {
    if (method === 'GET') return deny('body/get', 'GET requests must not have a body');
    const b = bodyBan(req.body);
    if (b) return deny(b.rule, b.reason);
  }

  for (const r of rules) {
    const bad = badRule(r);
    if (bad) return deny('policy/bad-rule', `programming error in endpoint rule "${String(r?.id)}": ${bad}`);
  }

  const rule = rules.find((r) => r.method === method && r.host === parsed.hostname && r.path.test(pathname));
  if (!rule) return deny('no-matching-rule', `${method} ${parsed.hostname}${pathname} matches no endpoint rule`);

  const allowed = new Set([...rule.allowedQuery, ...Object.keys(rule.requiredQuery ?? {})]);
  for (const k of Object.keys(query)) {
    if (!allowed.has(k)) return deny(rule.id, `query key "${k}" is not allowed`);
  }
  for (const [k, v] of Object.entries(rule.requiredQuery ?? {})) {
    if (query[k] !== v) return deny(rule.id, `query "${k}" must be "${v}"`);
  }
  if (rule.checkBody) {
    const why = rule.checkBody(req.body);
    if (why) return deny(rule.id, why);
  }
  return { ok: true };
}
