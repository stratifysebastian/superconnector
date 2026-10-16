import type { IntuitHttp } from '@/core/contracts/adapter';
import type { Logger } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { IntuitError, faultMessage, parseFault, type IntuitFault } from './errors';
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

/** Deny by default. GET and the two create POSTs only; a POST is never retried. Logs hold method, path template and status: no ids, amounts, names or emails. */
export function createIntuitHttp(opts: IntuitHttpOptions): IntuitHttp {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const rules = opts.rules ?? INTUIT_RULES;
  const host = intuitHostFor(opts.env);

  return {
    async json<T>(req: { method: 'GET' | 'POST'; path: string; query?: Record<string, string | number | boolean | undefined>; body?: Record<string, unknown> }): Promise<T> {
      // Snapshot every input once; only these locals are used from here on.
      const { method, path, query: rawQuery, body: rawBody } = req;
      // Serialised once, before the policy check sees the same snapshot, so what is checked is what is sent.
      const body = rawBody === undefined ? undefined : (JSON.parse(JSON.stringify(rawBody)) as Record<string, unknown>);
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
      const verdict = checkIntuitRequest(rules, { method, host, path, query, body, realmId: opts.realmId, env: opts.env });
      if (!verdict.ok) throw new GuardrailError(verdict.rule, `IntuitHttp blocked the request: ${verdict.reason}`);

      const qs = new URLSearchParams({ ...query, minorversion: INTUIT_MINOR_VERSION }).toString();
      const url = `https://${host}${path}?${qs}`;
      const started = Date.now();
      let attempts = 0;
      let status: number | undefined;
      // Intuit's support id and error code/name help them trace a failure; neither carries company data.
      let intuitTid: string | undefined;
      let fault: IntuitFault = {};
      const intuitCode = () => [fault.code, fault.name].filter(Boolean).join(' ') || undefined;
      const log = (outcome: string) =>
        opts.log?.info({
          msg: 'intuit_http', outcome, method, path: verdict.rule.template, status, durationMs: Date.now() - started, attempts,
          ...(intuitTid ? { intuitTid } : {}),
          ...(intuitCode() ? { intuitCode: intuitCode() } : {}),
        });
      const write = method === 'POST';
      const fail = (err: ProviderError): never => {
        log(err.kind);
        throw err instanceof IntuitError ? err : new IntuitError(err.kind, err.message, err.status, fault.code, fault.name, intuitTid);
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
            headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(write ? { 'content-type': 'application/json' } : {}) },
            ...(write ? { body: JSON.stringify(body) } : {}),
            signal,
            redirect: 'error',
          });
        } catch {
          status = undefined;
          // A write that timed out may still have gone through: say so, and never retry it.
          const unsure = write ? ' The record may or may not have been created; search for it before trying again.' : '';
          if (signal.aborted) return fail(new ProviderError('timeout', `QuickBooks request timed out.${unsure}`));
          return fail(new ProviderError('upstream_error', `QuickBooks request failed.${unsure}`));
        }
        status = res.status;
        const tid = res.headers.get('intuit_tid');
        intuitTid = tid && /^[\w-]{1,100}$/.test(tid) ? tid : undefined;

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
          if (write) return fail(new ProviderError('upstream_error', 'QuickBooks rejected the credentials for this write; nothing was retried. Try again.', 401));
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

        // Retries are for GET only. A POST is never retried: a repeat could create the record twice.
        if (res.status === 429 || res.status >= 500) {
          if (write) {
            fault = await readFault(res);
            return fail(
              res.status === 429
                ? new ProviderError('rate_limited', 'QuickBooks rate limit exceeded; the write was not retried', res.status)
                : new ProviderError('upstream_error', 'QuickBooks service error; the write was not retried and may not have completed. Search for the record before trying again.', res.status),
            );
          }
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
        fault = await readFault(res);
        if (res.status === 403) {
          return fail(
            new ProviderError(
              'upstream_error',
              'QuickBooks refused the request (403). Most often the app keys do not match the environment: development keys need the sandbox company and INTUIT_ENV=sandbox, production keys need a live company and INTUIT_ENV=production.',
              403,
            ),
          );
        }
        if (res.status === 404) return fail(new ProviderError('not_found', 'QuickBooks resource not found', 404));
        return fail(new ProviderError('upstream_error', faultMessage(verdict.rule.label, res.status, fault), res.status));
      }
    },
  };
}

/** Intuit's error code, short error name and fault type only; never free text such as Detail. */
async function readFault(res: Response): Promise<IntuitFault> {
  try {
    return parseFault(await res.json());
  } catch {
    return {};
  }
}
