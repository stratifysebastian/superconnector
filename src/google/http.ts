import type { GoogleHttp } from '@/core/contracts/adapter';
import type { Logger } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { ENDPOINT_RULES } from './endpoints';
import { checkRequest, type EndpointRule } from './endpoints/policy';
import { mapAuthError } from './errors';

const MAX_RETRIES = 3;
const BASE_MS = 500;
const MAX_DELAY_MS = 8000;

export interface GoogleHttpOptions {
  getAccessToken: () => Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: Logger;
  /** Endpoint allowlist. Defaults to ENDPOINT_RULES; a request matching no rule is rejected. */
  rules?: EndpointRule[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readErrorReasons(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as {
      error?: { errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] };
    };
    const reasons: string[] = [];
    for (const e of body?.error?.errors ?? []) if (typeof e?.reason === 'string') reasons.push(e.reason);
    for (const d of body?.error?.details ?? []) if (typeof d?.reason === 'string') reasons.push(d.reason);
    return reasons;
  } catch {
    return [];
  }
}

export function createGoogleHttp(opts: GoogleHttpOptions): GoogleHttp {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const rules = opts.rules ?? ENDPOINT_RULES;

  return {
    async json<T>(req: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      url: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    }): Promise<T> {
      // Snapshot every input exactly once; only these locals are used from here on (getters could lie twice).
      const { method, url, query: rawQuery, body: rawBody } = req;
      const block = (rule: string, reason: string): never => {
        throw new GuardrailError(rule, `GoogleHttp blocked the request: ${reason}`);
      };

      const query: Record<string, string> = {};
      if (rawQuery !== undefined && rawQuery !== null) {
        if (typeof rawQuery !== 'object' || Array.isArray(rawQuery)) block('query/type', 'query must be a plain object');
        for (const [k, v] of Object.entries(rawQuery)) {
          if (v === undefined) continue;
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            block('query/value', `query value for "${k}" must be a string, number or boolean`);
          }
          query[k] = String(v);
        }
      }

      // Serialise once: the checked body is exactly the body that is sent.
      let bodyJson: string | undefined;
      let body: unknown;
      if (rawBody !== undefined) {
        try {
          bodyJson = JSON.stringify(rawBody);
        } catch {
          return block('body/unserialisable', 'request body is not JSON-serialisable');
        }
        if (bodyJson === undefined) return block('body/unserialisable', 'request body is not JSON-serialisable');
        body = JSON.parse(bodyJson) as unknown;
      }

      const verdict = checkRequest(rules, { method, url, query, body });
      if (!verdict.ok) return block(verdict.rule, verdict.reason);

      const parsed = new URL(url);
      const qs = new URLSearchParams(query).toString();
      const fullUrl = `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ''}`;
      const path = parsed.pathname;
      const started = Date.now();
      let attempts = 0;
      let status: number | undefined;

      const log = (outcome: string) => {
        opts.log?.info({
          msg: 'google_http',
          outcome,
          method,
          path,
          status,
          durationMs: Date.now() - started,
          attempts,
        });
      };
      const fail = (err: ProviderError): never => {
        log(err.kind);
        throw err;
      };
      const refresh = async (): Promise<string> => {
        try {
          return await opts.getAccessToken();
        } catch (e) {
          const m = mapAuthError(e);
          if (m instanceof ProviderError) return fail(m);
          throw m;
        }
      };

      let token = await refresh();
      let refreshed = false;
      let retries = 0;

      for (;;) {
        attempts++;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
        if (bodyJson !== undefined) headers['content-type'] = 'application/json';

        let res: Response;
        try {
          res = await doFetch(fullUrl, { method, headers, body: bodyJson, signal, redirect: 'error' });
        } catch {
          status = undefined;
          if (signal.aborted) return fail(new ProviderError('timeout', 'Google request timed out'));
          return fail(new ProviderError('upstream_error', 'Google request failed'));
        }
        status = res.status;

        if (res.ok) {
          let data: T;
          try {
            data = res.status === 204 ? ({} as T) : ((await res.json()) as T);
          } catch {
            if (signal.aborted) return fail(new ProviderError('timeout', 'Google request timed out'));
            return fail(new ProviderError('upstream_error', 'Google returned an unreadable response', res.status));
          }
          log('ok');
          return data;
        }

        if (res.status === 401) {
          if (!refreshed) {
            refreshed = true;
            token = await refresh();
            continue;
          }
          return fail(
            new ProviderError('needs_reconnect', 'Google rejected the credentials; reconnect the account', 401),
          );
        }

        const reasons = res.status === 403 ? await readErrorReasons(res) : [];
        const rateLimited =
          res.status === 429 ||
          (res.status === 403 && reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'));
        const serverError = res.status >= 500;

        if (serverError && !rateLimited && method !== 'GET' && method !== 'PUT') {
          return fail(
            new ProviderError(
              'upstream_error',
              'Google returned a server error; the change may or may not have been applied — check before retrying',
              res.status,
            ),
          );
        }

        if (rateLimited || serverError) {
          if (retries >= MAX_RETRIES) {
            return rateLimited
              ? fail(new ProviderError('rate_limited', 'Google rate limit exceeded after retries', res.status))
              : fail(new ProviderError('upstream_error', 'Google service error after retries', res.status));
          }
          const header = res.headers.get('retry-after');
          const ra = header === null ? NaN : Number(header);
          const delay =
            Number.isFinite(ra) && ra >= 0
              ? Math.min(MAX_DELAY_MS, ra * 1000)
              : Math.min(MAX_DELAY_MS, BASE_MS * 2 ** retries * random());
          retries++;
          await sleep(delay);
          continue;
        }

        if (res.status === 403) {
          if (reasons.includes('insufficientPermissions') || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
            return fail(new ProviderError('missing_scope', 'Google account is missing a required permission', 403));
          }
          return fail(new ProviderError('upstream_error', 'Google refused the request', 403));
        }
        if (res.status === 404) return fail(new ProviderError('not_found', 'Google resource not found', 404));
        return fail(new ProviderError('upstream_error', 'Google request failed', res.status));
      }
    },
  };
}
