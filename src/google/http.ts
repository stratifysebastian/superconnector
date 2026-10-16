import { randomUUID } from 'node:crypto';
import type { GoogleHttp } from '@/core/contracts/adapter';
import type { Logger } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { ENDPOINT_RULES } from './endpoints';
import { buildSelfMime, isPlainAddress, SELF_SEND_URL } from './endpoints/gmail-self-send';
import { checkRequest, type EndpointRule, type Transport } from './endpoints/policy';
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
  /** The account's own address (from the stored account, never caller input). Required by sendToSelf; the policy checks the message against it. */
  selfEmail?: string;
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

  type Query = Record<string, string | number | boolean | undefined>;
  const block = (rule: string, reason: string): never => {
    throw new GuardrailError(rule, `GoogleHttp blocked the request: ${reason}`);
  };

  function snapshotQuery(rawQuery: Query | undefined): Record<string, string> {
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
    return query;
  }

  /** Serialise once: the checked body is exactly the body that is sent. */
  function snapshotJson(rawBody: unknown): { json: string | undefined; parsed: unknown } {
    if (rawBody === undefined) return { json: undefined, parsed: undefined };
    let json: string | undefined;
    try {
      json = JSON.stringify(rawBody);
    } catch {
      return block('body/unserialisable', 'request body is not JSON-serialisable');
    }
    if (json === undefined) return block('body/unserialisable', 'request body is not JSON-serialisable');
    return { json, parsed: JSON.parse(json) as unknown };
  }

  interface Outgoing {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    url: string;
    query: Record<string, string>;
    /** What the policy checks: the JSON body, or the metadata part of an upload. */
    policyBody: unknown;
    payload: string | Uint8Array<ArrayBuffer> | undefined;
    contentType: string | undefined;
    accept: string;
    transport: Transport;
  }

  async function send<T>(out: Outgoing, onOk: (res: Response) => Promise<T>): Promise<T> {
    const { method, url, query, payload, contentType, accept, transport } = out;
    const verdict = checkRequest(rules, { method, url, query, body: out.policyBody, transport, selfEmail: opts.selfEmail });
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
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept };
      if (contentType !== undefined) headers['content-type'] = contentType;

      let res: Response;
      try {
        res = await doFetch(fullUrl, { method, headers, body: payload, signal, redirect: 'error' });
      } catch {
        status = undefined;
        if (signal.aborted) return fail(new ProviderError('timeout', 'Google request timed out'));
        return fail(new ProviderError('upstream_error', 'Google request failed'));
      }
      status = res.status;

      if (res.ok) {
        let data: T;
        try {
          data = await onOk(res);
        } catch (e) {
          if (e instanceof ProviderError) return fail(e);
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
        return fail(new ProviderError('needs_reconnect', 'Google rejected the credentials; reconnect the account', 401));
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
  }

  const readJson = async <T>(res: Response): Promise<T> => (res.status === 204 ? ({} as T) : ((await res.json()) as T));

  return {
    async json<T>(req: { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; url: string; query?: Query; body?: unknown }): Promise<T> {
      // Snapshot every input exactly once; only these locals are used from here on (getters could lie twice).
      const { method, url, query: rawQuery, body: rawBody } = req;
      const query = snapshotQuery(rawQuery);
      const { json, parsed } = snapshotJson(rawBody);
      return send<T>(
        { method, url, query, policyBody: parsed, payload: json, contentType: json === undefined ? undefined : 'application/json', accept: 'application/json', transport: 'json' },
        readJson,
      );
    },

    async upload<T>(req: { url: string; query?: Query; metadata: unknown; content: Uint8Array; contentType: string }): Promise<T> {
      const { url, query: rawQuery, metadata, content, contentType } = req;
      const query = snapshotQuery(rawQuery);
      const { json, parsed } = snapshotJson(metadata);
      if (json === undefined) return block('upload/metadata', 'upload metadata is required');
      if (!(content instanceof Uint8Array)) return block('upload/content', 'upload content must be bytes');
      // The type goes into a part header verbatim, so it must be a plain type/subtype (no CR/LF, no extra headers).
      if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
        return block('upload/content-type', 'upload content type must be a plain type/subtype');
      }
      const boundary = `sc-${randomUUID()}`;
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
      );
      const tail = enc.encode(`\r\n--${boundary}--\r\n`);
      const payload = new Uint8Array(head.length + content.length + tail.length);
      payload.set(head, 0);
      payload.set(content, head.length);
      payload.set(tail, head.length + content.length);
      return send<T>(
        { method: 'POST', url, query, policyBody: parsed, payload, contentType: `multipart/related; boundary=${boundary}`, accept: 'application/json', transport: 'upload' },
        readJson,
      );
    },

    async sendToSelf(req: { subject: string; body: string; htmlBody?: string }): Promise<{ id: string; threadId?: string }> {
      const { subject, body, htmlBody } = req;
      const self = opts.selfEmail;
      if (!isPlainAddress(self)) return block('self-send/no-address', 'the account address is missing or is not a plain address');
      if (typeof subject !== 'string' || typeof body !== 'string' || (htmlBody !== undefined && typeof htmlBody !== 'string')) {
        return block('self-send/input', 'subject, body and htmlBody must be strings');
      }
      // From and To are both `self`. The recipient is not an input, and the policy re-checks the finished message.
      const raw = Buffer.from(buildSelfMime(self, { subject, body, ...(htmlBody !== undefined ? { htmlBody } : {}) })).toString('base64url');
      const { json, parsed } = snapshotJson({ raw });
      const sent = await send<{ id?: unknown; threadId?: unknown }>(
        { method: 'POST', url: SELF_SEND_URL, query: {}, policyBody: parsed, payload: json, contentType: 'application/json', accept: 'application/json', transport: 'self-send' },
        readJson,
      );
      if (typeof sent.id !== 'string') throw new ProviderError('upstream_error', 'Google returned an unreadable response');
      return { id: sent.id, ...(typeof sent.threadId === 'string' ? { threadId: sent.threadId } : {}) };
    },

    async download(req: { url: string; query?: Query; maxBytes: number }): Promise<{ bytes: Uint8Array; contentType: string }> {
      const { url, query: rawQuery, maxBytes } = req;
      const query = snapshotQuery(rawQuery);
      if (!Number.isInteger(maxBytes) || maxBytes <= 0) return block('download/max-bytes', 'maxBytes must be a positive integer');
      return send(
        { method: 'GET', url, query, policyBody: undefined, payload: undefined, contentType: undefined, accept: '*/*', transport: 'download' },
        async (res) => ({ bytes: await readCapped(res, maxBytes), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }),
      );
    },
  };
}

const tooLarge = (maxBytes: number) =>
  new ProviderError('upstream_error', `File content is larger than ${Math.floor(maxBytes / 1_000_000)} MB, which this server can return`);

/** Reads the body, stopping (and cancelling the stream) as soon as it passes maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(maxBytes);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
