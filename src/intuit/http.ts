import type { IntuitHttp } from '@/core/contracts/adapter';
import type { Logger } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import {
  INTUIT_MINOR_VERSION,
  INTUIT_RULES,
  checkIntuitRequest,
  intuitHostFor,
  type IntuitEnv,
  type IntuitRule,
} from './endpoints';

const MAX_RETRIES = 3;
const BASE_MS = 500;
const MAX_DELAY_MS = 8000;

export interface IntuitHttpOptions {
  /** `force` asks for a new token (after a 401). */
  getAccessToken: (force?: boolean) => Promise<string>;
  /** The account's own company, from the stored account (never caller input). */
  realmId: string;
  env: IntuitEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: Logger;
  /** Endpoint allowlist. Defaults to INTUIT_RULES; a request matching no rule is rejected. */
  rules?: IntuitRule[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deny by default, GET only. Logs hold method, path template and status: no ids, amounts, names or emails. */
export function createIntuitHttp(opts: IntuitHttpOptions): IntuitHttp {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const rules = opts.rules ?? INTUIT_RULES;
  const host = intuitHostFor(opts.env);

  return {
    async json<T>(req: { method: 'GET'; path: string; query?: Record<string, string | number | boolean | undefined> }): Promise<T> {
      // Snapshot every input once; only these locals are used from here on.
      const { method, path, query: rawQuery } = req;
      const query: Record<string, string> = {};
      if (rawQuery !== undefined && rawQuery !== null) {
        if (typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
          throw new GuardrailError('query/type', 'IntuitHttp blocked the request: query must be a plain object');
        }
        for (const [k, v] of Object.entries(rawQuery)) {
          if (v === undefined) continue;
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            throw new GuardrailError('query/value', 'IntuitHttp blocked the request: query values must be strings, numbers or booleans');
          }
          query[k] = String(v);
        }
      }
      const verdict = checkIntuitRequest(rules, { method, host, path, query, realmId: opts.realmId, env: opts.env });
      if (!verdict.ok) throw new GuardrailError(verdict.rule, `IntuitHttp blocked the request: ${verdict.reason}`);

      const qs = new URLSearchParams({ ...query, minorversion: INTUIT_MINOR_VERSION }).toString();
      const url = `https://${host}${path}?${qs}`;
      const started = Date.now();
      let attempts = 0;
      let status: number | undefined;
      const log = (outcome: string) =>
        opts.log?.info({ msg: 'intuit_http', outcome, method, path: verdict.rule.template, status, durationMs: Date.now() - started, attempts });
      const fail = (err: ProviderError): never => {
        log(err.kind);
        throw err;
      };

      let token = await opts.getAccessToken();
      let refreshed = false;
      let retries = 0;

      for (;;) {
        attempts++;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
        let res: Response;
        try {
          res = await doFetch(url, {
            method,
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            signal,
            redirect: 'error',
          });
        } catch {
          status = undefined;
          if (signal.aborted) return fail(new ProviderError('timeout', 'QuickBooks request timed out'));
          return fail(new ProviderError('upstream_error', 'QuickBooks request failed'));
        }
        status = res.status;

        if (res.ok) {
          let data: T;
          try {
            data = (await res.json()) as T;
          } catch {
            return fail(new ProviderError('upstream_error', 'QuickBooks returned an unreadable response', res.status));
          }
          log('ok');
          return data;
        }

        if (res.status === 401) {
          if (!refreshed) {
            refreshed = true;
            try {
              token = await opts.getAccessToken(true);
            } catch (e) {
              if (e instanceof ProviderError) return fail(e);
              throw e;
            }
            continue;
          }
          return fail(new ProviderError('needs_reconnect', 'QuickBooks rejected the credentials; reconnect the company', 401));
        }

        // Retries are for GET only (this client has no other verb in Q0, so the check is a guard for later phases).
        if ((res.status === 429 || res.status >= 500) && method === 'GET') {
          if (retries >= MAX_RETRIES) {
            return res.status === 429
              ? fail(new ProviderError('rate_limited', 'QuickBooks rate limit exceeded after retries', res.status))
              : fail(new ProviderError('upstream_error', 'QuickBooks service error after retries', res.status));
          }
          const header = res.headers.get('retry-after');
          const ra = header === null ? NaN : Number(header);
          const delay =
            Number.isFinite(ra) && ra >= 0 ? Math.min(MAX_DELAY_MS, ra * 1000) : Math.min(MAX_DELAY_MS, BASE_MS * 2 ** retries * random());
          retries++;
          await sleep(delay);
          continue;
        }
        if (res.status === 403) return fail(new ProviderError('missing_scope', 'QuickBooks refused the request: the company has not granted access', 403));
        if (res.status === 404) return fail(new ProviderError('not_found', 'QuickBooks resource not found', 404));
        return fail(new ProviderError('upstream_error', 'QuickBooks request failed', res.status));
      }
    },
  };
}
