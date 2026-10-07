import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { ENDPOINT_RULES } from '@/google/endpoints';
import { GoogleAuthError, isInvalidGrant } from '@/google/errors';
import { createGoogleHttp } from '@/google/http';
import { checkRequest } from '@/google/endpoints/policy';
import type { EndpointRule } from '@/google/endpoints/policy';

const URL_OK = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const URL_WRITE = 'https://www.googleapis.com/drive/v3/files/abc';
const HOST = 'www.googleapis.com';

/** Test-only: every query key the tests pass, so rules do not reject on query before the thing under test. */
const TEST_QUERY = ['fields', 'sendUpdates', 'sendNotifications', 'text', 'transferOwnership', 'q', 'a', 'b', 'c'];
/** Permissive test-only rules; the real ENDPOINT_RULES is empty in Phase 0. */
const TEST_RULES: EndpointRule[] = (['GET', 'POST', 'PATCH', 'PUT'] as const).flatMap((method) => [
  { id: `t-cal-${method}`, product: 'calendar' as const, method, host: HOST, path: /^\/calendar\/v3\/calendars\/primary\/events$/, allowedQuery: TEST_QUERY },
  { id: `t-drive-${method}`, product: 'drive' as const, method, host: HOST, path: /^\/drive\/v3\/files\/[^/]+$/, allowedQuery: TEST_QUERY },
]);
const TOKEN = 'tok-SECRET-MARKER-123';
const BODY_MARKER = 'BODY-MARKER-XYZ';
const QUERY_MARKER = 'QUERY-MARKER-QQQ';

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(responses: (Response | Error)[], extra: Partial<Parameters<typeof createGoogleHttp>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const delays: number[] = [];
  const events: LogEvent[] = [];
  let tokens = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const http = createGoogleHttp({
    getAccessToken: async () => (tokens++ === 0 ? TOKEN : TOKEN + '-2'),
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    log: { info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e) },
    rules: TEST_RULES,
    ...extra,
  });
  return { http, calls, delays, events };
}

async function kindOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected rejection');
}

const get = { method: 'GET' as const, url: URL_OK };

describe('createGoogleHttp', () => {
  it('sends bearer, query (skipping undefined) and JSON body', async () => {
    const { http, calls } = setup([res(200, { ok: 1 })]);
    const out = await http.json({
      method: 'POST',
      url: URL_WRITE,
      query: { a: 1, b: undefined, c: true },
      body: { x: 1 },
    });
    expect(out).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe(`${URL_WRITE}?a=1&c=true`);
    expect(calls[0]!.init.redirect).toBe('error');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"x":1}');
  });

  it('retries a 429 exactly 3 times then rate_limited, with jitter-bounded delays', async () => {
    const { http, calls, delays } = setup([res(429), res(429), res(429), res(429), res(200)]);
    const err = await kindOf(http.json(get));
    expect(err.kind).toBe('rate_limited');
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([250, 500, 1000]); // 500 * 2^n * 0.5
  });

  it('keeps delays within [0, base*2^n]', async () => {
    const { http, delays } = setup([res(429), res(429), res(429), res(429)], { random: () => 0.999 });
    await kindOf(http.json(get));
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(500 * 2 ** i);
    });
  });

  it('honours Retry-After, capped at 8s', async () => {
    const { http, delays } = setup([
      res(429, {}, { 'retry-after': '2' }),
      res(429, {}, { 'retry-after': '120' }),
      res(200, { ok: true }),
    ]);
    await http.json(get);
    expect(delays).toEqual([2000, 8000]);
  });

  it('succeeds after a 429 then 200', async () => {
    const { http, calls } = setup([res(429), res(200, { v: 1 })]);
    expect(await http.json(get)).toEqual({ v: 1 });
    expect(calls).toHaveLength(2);
  });

  it('treats 403 rateLimitExceeded as a rate limit', async () => {
    const body = { error: { errors: [{ reason: 'userRateLimitExceeded' }] } };
    const { http, calls } = setup([res(403, body), res(200, { v: 2 })]);
    expect(await http.json(get)).toEqual({ v: 2 });
    expect(calls).toHaveLength(2);
  });

  it('401 refreshes once and retries, then needs_reconnect', async () => {
    const ok = setup([res(401), res(200, { v: 3 })]);
    expect(await ok.http.json(get)).toEqual({ v: 3 });
    expect((ok.calls[1]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}-2`);

    const bad = setup([res(401), res(401), res(200)]);
    const err = await kindOf(bad.http.json(get));
    expect(err.kind).toBe('needs_reconnect');
    expect(bad.calls).toHaveLength(2);
  });

  it('maps invalid_grant from getAccessToken to needs_reconnect', async () => {
    const http = createGoogleHttp({
      getAccessToken: async () => {
        throw new GoogleAuthError('invalid_grant');
      },
      fetchImpl: (() => {
        throw new Error('should not fetch');
      }) as unknown as typeof fetch,
      rules: TEST_RULES,
    });
    expect((await kindOf(http.json(get))).kind).toBe('needs_reconnect');
  });

  it('maps scope 403, 404, other 4xx and 5xx', async () => {
    for (const reason of ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']) {
      const s = setup([res(403, { error: { errors: [{ reason }] } })]);
      expect((await kindOf(s.http.json(get))).kind).toBe('missing_scope');
    }
    expect((await kindOf(setup([res(403, {})]).http.json(get))).kind).toBe('upstream_error');
    expect((await kindOf(setup([res(404)]).http.json(get))).kind).toBe('not_found');
    expect((await kindOf(setup([res(400)]).http.json(get))).kind).toBe('upstream_error');
    const s5 = setup([res(500), res(500), res(500), res(500)]);
    expect((await kindOf(s5.http.json(get))).kind).toBe('upstream_error');
    expect(s5.calls).toHaveLength(4);
  });

  it('does not retry 5xx for POST or PATCH, but does for GET and PUT', async () => {
    for (const method of ['POST', 'PATCH'] as const) {
      const s = setup([res(500), res(200)]);
      const err = await kindOf(s.http.json({ method, url: URL_WRITE, body: {} }));
      expect(err.kind).toBe('upstream_error');
      expect(err.message).toContain('may or may not have been applied');
      expect(s.calls).toHaveLength(1);
    }
    const g = setup([res(500), res(500), res(500), res(500)]);
    expect((await kindOf(g.http.json(get))).kind).toBe('upstream_error');
    expect(g.calls).toHaveLength(4);
    const p = setup([res(503), res(200, { ok: 1 })]);
    await p.http.json({ method: 'PUT', url: URL_WRITE, body: {} });
    expect(p.calls).toHaveLength(2);
    const r = setup([res(429), res(200, {})]);
    await r.http.json({ method: 'POST', url: URL_WRITE, body: {} });
    expect(r.calls).toHaveLength(2);
  });

  it('produces timeout when the request hangs', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const http = createGoogleHttp({ getAccessToken: async () => TOKEN, fetchImpl, timeoutMs: 20, rules: TEST_RULES });
    expect((await kindOf(http.json(get))).kind).toBe('timeout');
  });

  it('rejects disallowed methods and hosts', async () => {
    const { http, calls } = setup([res(200)]);
    for (const method of ['DELETE', 'HEAD']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(http.json({ method, url: URL_OK } as any)).rejects.toThrow();
    }
    await expect(http.json({ method: 'GET', url: 'https://evil.example/x' })).rejects.toThrow();
    await expect(http.json({ method: 'GET', url: 'https://www.googleapis.com.evil.example/x' })).rejects.toThrow();
    await expect(http.json({ method: 'GET', url: 'http://www.googleapis.com/x' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('has no escape hatch beyond json()', () => {
    expect(Object.keys(setup([]).http)).toEqual(['json']);
  });

  it('error messages never leak token, query or body', async () => {
    const leaky = { error: { message: BODY_MARKER, errors: [{ reason: 'x', message: BODY_MARKER }] } };
    const cases: Response[][] = [
      [res(404, leaky)],
      [res(400, leaky)],
      [res(403, leaky)],
      [res(401, leaky), res(401, leaky)],
      [res(429, leaky), res(429, leaky), res(429, leaky), res(429, leaky)],
      [res(500, leaky), res(500, leaky), res(500, leaky), res(500, leaky)],
      [res(403, { error: { errors: [{ reason: 'insufficientPermissions', message: BODY_MARKER }] } })],
    ];
    for (const responses of cases) {
      const s = setup(responses);
      const err = await kindOf(s.http.json({ ...get, query: { q: QUERY_MARKER } }));
      const text = `${err.message} ${err.name} ${JSON.stringify(err)} ${err.stack ?? ''}`.split('\n')[0]!;
      for (const m of [TOKEN, QUERY_MARKER, BODY_MARKER]) expect(text).not.toContain(m);
      expect(err.message).not.toMatch(/token|q=/i);
    }
  });

  it('logs one event per call with path only, status, duration and attempts', async () => {
    const { http, events } = setup([res(429), res(200, {})]);
    await http.json({ ...get, query: { q: QUERY_MARKER } });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ method: 'GET', path: '/calendar/v3/calendars/primary/events', status: 200, attempts: 2 });
    expect(typeof e.durationMs).toBe('number');
    const json = JSON.stringify(e);
    expect(json).not.toContain(QUERY_MARKER);
    expect(json).not.toContain('?');
    expect(json).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Runtime guardrails: every rejection must be a GuardrailError and must never reach fetch.
// ---------------------------------------------------------------------------------------------------------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const NONE = { sendUpdates: 'none' };

/** Permissive on purpose (matches everything on every allowed host) to prove the hard bans win over a rule. */
const MATCH_ALL: EndpointRule[] = (['GET', 'POST', 'PATCH', 'PUT'] as const).flatMap((method) =>
  ['www.googleapis.com', 'gmail.googleapis.com', 'docs.googleapis.com'].map((host) => ({
    id: `all-${method}-${host}`,
    product: 'gmail' as const,
    method,
    host,
    path: /^\/.*$/,
    allowedQuery: [...TEST_QUERY, 'access_token', 'key', 'oauth_token', 'apikey', 'bearer_token', 'upload_protocol', 'ACCESS_TOKEN'],
  })),
);

type Req = Parameters<ReturnType<typeof createGoogleHttp>['json']>[0];
interface Reject {
  name: string;
  req: () => unknown;
  rules?: EndpointRule[];
  rule?: RegExp;
}

function getterMethod(): unknown {
  let n = 0;
  return {
    get method() {
      return n++ === 0 ? 'DELETE' : 'GET';
    },
    url: URL_WRITE,
  };
}

function getterUrl(): unknown {
  let n = 0;
  return {
    method: 'GET',
    get url() {
      return n++ === 0 ? 'https://evil.example/x' : URL_WRITE;
    },
  };
}

function cyclicBody(): unknown {
  const o: Record<string, unknown> = {};
  o.self = o;
  return { method: 'POST', url: URL_WRITE, body: o };
}

function deepBody(): unknown {
  let o: unknown = {};
  for (let i = 0; i < 100; i++) o = { a: o };
  return { method: 'POST', url: URL_WRITE, body: o };
}

function spreadBody(): unknown {
  const extra = { attendees: [{ email: 'x@y.co' }] };
  return { method: 'POST', url: URL_WRITE, body: { summary: 's', ...extra } };
}

const REJECTIONS: Reject[] = [
  { name: 'method via getter (first read is what counts)', req: getterMethod },
  { name: 'url via getter (first read is what counts)', req: getterUrl },
  { name: 'DELETE method', req: () => ({ method: 'DELETE', url: URL_WRITE }), rule: /method/ },
  { name: 'lowercase method', req: () => ({ method: 'get', url: URL_WRITE }), rule: /method/ },
  { name: '$httpMethod query key', req: () => ({ method: 'GET', url: URL_WRITE, query: { $httpMethod: 'DELETE' } }), rule: /query-dollar/ },
  { name: '$.xgafv query key', req: () => ({ method: 'GET', url: URL_WRITE, query: { '$.xgafv': '1' } }), rule: /query-dollar/ },
  { name: 'X-HTTP-Method-Override query key', req: () => ({ method: 'POST', url: URL_WRITE, query: { 'X-HTTP-Method-Override': 'DELETE' }, body: {} }), rule: /method-override/ },
  { name: '_method query key (any case)', req: () => ({ method: 'POST', url: URL_WRITE, query: { _METHOD: 'DELETE' }, body: {} }), rule: /method-override/ },
  { name: 'httpMethod query key', req: () => ({ method: 'POST', url: URL_WRITE, query: { HTTPMETHOD: 'DELETE' }, body: {} }), rule: /method-override/ },
  { name: '? inside url', req: () => ({ method: 'GET', url: `${URL_WRITE}?x=1` }), rule: /query-in-url/ },
  { name: '# inside url', req: () => ({ method: 'GET', url: `${URL_WRITE}#x` }), rule: /query-in-url/ },
  { name: '.. path', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/../../gmail/v1/users/me/messages/send' }), rule: /path-trickery/ },
  { name: '%2e path', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/%2e%2e/x' }), rule: /path-trickery/ },
  { name: '%2E%2E mixed case', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/%2E%2E/x' }), rule: /path-trickery/ },
  { name: '%2f path', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/a%2fb' }), rule: /path-trickery/ },
  { name: 'backslash path', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files\\a' }), rule: /path-trickery/ },
  { name: 'tab smuggled into a segment', req: () => ({ method: 'POST', url: `${GMAIL}/messages/se\tnd`, body: {} }), rule: /control-chars/ },
  { name: 'userinfo', req: () => ({ method: 'GET', url: 'https://user:pw@www.googleapis.com/drive/v3/files/a' }), rule: /userinfo/ },
  { name: 'userinfo host-confusion', req: () => ({ method: 'GET', url: 'https://www.googleapis.com@evil.example/drive/v3/files/a' }), rule: /userinfo/ },
  { name: 'http (not https)', req: () => ({ method: 'GET', url: 'http://www.googleapis.com/drive/v3/files/a' }) },
  { name: 'explicit port', req: () => ({ method: 'GET', url: 'https://www.googleapis.com:8443/drive/v3/files/a' }), rule: /port/ },
  { name: 'unknown host', req: () => ({ method: 'GET', url: 'https://evil.example/drive/v3/files/a' }), rule: /url\/host/ },
  { name: 'lookalike host', req: () => ({ method: 'GET', url: 'https://www.googleapis.com.evil.example/drive/v3/files/a' }), rule: /url\/host/ },
  { name: 'trailing-dot host', req: () => ({ method: 'GET', url: 'https://www.googleapis.com./drive/v3/files/a' }), rule: /url\/host/ },
  { name: 'oauth2 host', req: () => ({ method: 'POST', url: 'https://oauth2.googleapis.com/token', body: {} }), rule: /url\/host/ },
  { name: 'non-string url', req: () => ({ method: 'GET', url: 42 }), rule: /url\/type/ },
  { name: 'no matching rule (path)', req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' }), rule: /no-matching-rule/ },
  { name: 'no matching rule (method)', req: () => ({ method: 'PUT', url: URL_WRITE, body: {} }), rules: [], rule: /no-matching-rule/ },
  { name: 'no matching rule (host)', req: () => ({ method: 'GET', url: 'https://docs.googleapis.com/v1/documents/x' }), rule: /no-matching-rule/ },
  { name: 'GET with a body', req: () => ({ method: 'GET', url: URL_WRITE, body: {} }), rule: /body\/get/ },
  { name: 'unserialisable body (cycle)', req: cyclicBody, rule: /unserialisable/ },

  // Hard bans, with rules that would otherwise match everything.
  { name: 'ban: gmail messages/send', req: () => ({ method: 'POST', url: `${GMAIL}/messages/send`, body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'ban: gmail drafts/send', req: () => ({ method: 'POST', url: `${GMAIL}/drafts/send`, body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'ban: upload gmail send', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send', body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'ban: percent-encoded send segment', req: () => ({ method: 'POST', url: `${GMAIL}/messages/se%6ed`, body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'ban: SEND uppercase segment', req: () => ({ method: 'POST', url: `${GMAIL}/messages/SEND`, body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'ban: messages trash', req: () => ({ method: 'POST', url: `${GMAIL}/messages/abc/trash`, body: {} }), rules: MATCH_ALL, rule: /trash/ },
  { name: 'ban: threads untrash', req: () => ({ method: 'POST', url: `${GMAIL}/threads/abc/untrash`, body: {} }), rules: MATCH_ALL, rule: /untrash/ },
  { name: 'ban: batchDelete', req: () => ({ method: 'POST', url: `${GMAIL}/messages/batchDelete`, body: {} }), rules: MATCH_ALL, rule: /batchdelete/ },
  { name: 'ban: messages/import', req: () => ({ method: 'POST', url: `${GMAIL}/messages/import`, body: {} }), rules: MATCH_ALL, rule: /import/ },
  { name: 'ban: messages/insert', req: () => ({ method: 'POST', url: `${GMAIL}/messages/insert`, body: {} }), rules: MATCH_ALL, rule: /gmail-insert/ },
  { name: 'ban: gmail settings/filters', req: () => ({ method: 'GET', url: `${GMAIL}/settings/filters` }), rules: MATCH_ALL, rule: /gmail-settings/ },
  { name: 'ban: gmail settings/forwardingAddresses (any user)', req: () => ({ method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/a%40b.co/settings/forwardingAddresses', body: {} }), rules: MATCH_ALL, rule: /gmail-settings/ },
  { name: 'ban: gmail settings/delegates deep path', req: () => ({ method: 'GET', url: `${GMAIL}/settings/delegates/x` }), rules: MATCH_ALL, rule: /gmail-settings/ },
  { name: 'ban: drive permissions POST', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files/abc/permissions', body: { x: 1 } }), rules: MATCH_ALL, rule: /permissions-write/ },
  { name: 'ban: drive permissions PATCH', req: () => ({ method: 'PATCH', url: 'https://www.googleapis.com/drive/v3/files/abc/permissions/p1', body: {} }), rules: MATCH_ALL, rule: /permissions-write/ },
  { name: 'ban: calendar acl GET', req: () => ({ method: 'GET', url: `${CAL}/acl` }), rules: MATCH_ALL, rule: /acl/ },
  { name: 'ban: calendar acl write', req: () => ({ method: 'POST', url: `${CAL}/acl`, query: NONE, body: {} }), rules: MATCH_ALL, rule: /acl/ },
  { name: 'ban: quickAdd', req: () => ({ method: 'POST', url: `${CAL}/events/quickAdd`, query: { ...NONE, text: 'x' }, body: {} }), rules: MATCH_ALL, rule: /quickadd/ },
  { name: 'ban: custom method :send', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/gmail/v1/users/me/drafts/abc:send', body: {} }), rules: MATCH_ALL, rule: /custom-method|gmail-send/ },
  { name: 'ban: custom method :trash', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files/abc:trash', body: {} }), rules: MATCH_ALL, rule: /custom-method/ },
  { name: 'ban: /batch path', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/batch/calendar/v3', body: {} }), rules: MATCH_ALL, rule: /batch/ },
  { name: 'ban: drive emptyTrash', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files/emptyTrash', body: {} }), rules: MATCH_ALL, rule: /emptytrash/ },
  { name: 'ban: calendar POST without sendUpdates', req: () => ({ method: 'POST', url: `${CAL}/events`, body: { summary: 's' } }), rules: MATCH_ALL, rule: /calendar-send-updates/ },
  { name: 'ban: calendar PATCH with sendUpdates=all', req: () => ({ method: 'PATCH', url: `${CAL}/events/e1`, query: { sendUpdates: 'all' }, body: {} }), rules: MATCH_ALL, rule: /send-updates/ },
  { name: 'ban: calendar PUT with sendUpdates=externalOnly', req: () => ({ method: 'PUT', url: `${CAL}/events/e1`, query: { sendUpdates: 'externalOnly' }, body: {} }), rules: MATCH_ALL, rule: /send-updates/ },
  { name: 'ban: sendNotifications=true', req: () => ({ method: 'POST', url: `${CAL}/events`, query: { ...NONE, sendNotifications: true }, body: {} }), rules: MATCH_ALL, rule: /send-notifications/ },
  { name: 'ban: transferOwnership', req: () => ({ method: 'PATCH', url: 'https://www.googleapis.com/drive/v3/files/abc', query: { transferOwnership: true }, body: {} }), rules: MATCH_ALL, rule: /transfer-ownership/ },

  // Universal body checks, recursive.
  { name: 'body: attendees at top level', req: () => ({ method: 'POST', url: URL_WRITE, body: { attendees: [] } }), rule: /attendees/ },
  { name: 'body: nested attendees', req: () => ({ method: 'POST', url: URL_WRITE, body: { a: { b: [{ c: { attendees: [{ email: 'x@y.co' }] } }] } } }), rule: /attendees/ },
  { name: 'body: spread attendees', req: spreadBody, rule: /attendees/ },
  { name: 'body: Attendees key case', req: () => ({ method: 'POST', url: URL_WRITE, body: { Attendees: [] } }), rule: /attendees/ },
  { name: 'body: addedAttendees', req: () => ({ method: 'POST', url: URL_WRITE, body: { addedAttendees: [] } }), rule: /attendees/ },
  { name: 'body: attendeeEmails', req: () => ({ method: 'POST', url: URL_WRITE, body: { attendeeEmails: [] } }), rule: /attendees/ },
  { name: 'body: addedAttendeeEmails', req: () => ({ method: 'POST', url: URL_WRITE, body: { x: { addedAttendeeEmails: [] } } }), rule: /attendees/ },
  { name: 'body: removedAttendeeEmails', req: () => ({ method: 'POST', url: URL_WRITE, body: { removedAttendeeEmails: [] } }), rule: /attendees/ },
  { name: 'body: guestPermissions', req: () => ({ method: 'POST', url: URL_WRITE, body: { guestPermissions: {} } }), rule: /attendees/ },
  { name: 'body: attendees via toJSON', req: () => ({ method: 'POST', url: URL_WRITE, body: { toJSON: () => ({ attendees: [] }) } }), rule: /attendees/ },
  { name: 'body: trashed true', req: () => ({ method: 'PATCH', url: URL_WRITE, body: { trashed: true } }), rule: /trashed/ },
  { name: 'body: nested trashed true', req: () => ({ method: 'PATCH', url: URL_WRITE, body: { requests: [{ update: { trashed: true } }] } }), rule: /trashed/ },
  { name: "body: trashed 'true'", req: () => ({ method: 'PATCH', url: URL_WRITE, body: { trashed: 'true' } }), rule: /trashed/ },
  { name: 'body: addLabelIds TRASH', req: () => ({ method: 'POST', url: URL_WRITE, body: { addLabelIds: ['INBOX', 'TRASH'] } }), rule: /trash-label/ },
  { name: 'body: labelIds trash lowercase', req: () => ({ method: 'POST', url: URL_WRITE, body: { labelIds: ['trash'] } }), rule: /trash-label/ },
  { name: 'body: nested removeLabelIds TRASH', req: () => ({ method: 'POST', url: URL_WRITE, body: { m: { removeLabelIds: ['TRASH'] } } }), rule: /trash-label/ },
  { name: 'body: responseStatus', req: () => ({ method: 'PATCH', url: URL_WRITE, body: { responseStatus: 'accepted' } }), rule: /rsvp/ },
  { name: 'body: nested responseStatus', req: () => ({ method: 'PATCH', url: URL_WRITE, body: { x: [{ y: { responseStatus: 'declined' } }] } }), rule: /rsvp/ },
  { name: 'body: permission shape (role + emailAddress)', req: () => ({ method: 'POST', url: URL_WRITE, body: { role: 'writer', type: 'user', emailAddress: 'a@b.co' } }), rule: /permission-shape/ },
  { name: 'body: nested permission shape (type + domain)', req: () => ({ method: 'POST', url: URL_WRITE, body: { w: [{ type: 'domain', domain: 'b.co' }] } }), rule: /permission-shape/ },
  { name: 'body: too deeply nested', req: deepBody, rule: /body-depth/ },

  // H4: Calendar deletes in disguise.
  { name: 'ban: calendars clear', req: () => ({ method: 'POST', url: `${CAL}/clear`, query: NONE, body: {} }), rules: MATCH_ALL, rule: /calendar-clear/ },
  { name: 'ban: calendars clear (uppercase, no query)', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/primary/CLEAR', body: {} }), rules: MATCH_ALL, rule: /calendar-clear/ },
  { name: 'ban: calendars:clear custom verb', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/primary:clear', query: NONE, body: {} }), rules: MATCH_ALL, rule: /calendar-clear/ },
  { name: 'body: status cancelled', req: () => ({ method: 'PATCH', url: `${CAL}/events/e1`, query: NONE, body: { status: 'cancelled' } }), rules: MATCH_ALL, rule: /status-cancelled/ },
  { name: 'body: status Cancelled (case, padded)', req: () => ({ method: 'PATCH', url: `${CAL}/events/e1`, query: NONE, body: { Status: ' Cancelled ' } }), rules: MATCH_ALL, rule: /status-cancelled/ },
  { name: 'body: nested status cancelled', req: () => ({ method: 'POST', url: URL_WRITE, body: { a: [{ b: { status: 'CANCELLED' } }] } }), rule: /status-cancelled/ },

  // H4: Gmail messages.insert / import by collection POST, watch, stop.
  { name: 'ban: gmail messages collection POST', req: () => ({ method: 'POST', url: `${GMAIL}/messages`, body: {} }), rules: MATCH_ALL, rule: /messages-collection-post/ },
  { name: 'ban: gmail messages collection POST (other user id)', req: () => ({ method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/a%40b.co/messages', body: {} }), rules: MATCH_ALL, rule: /messages-collection-post/ },
  { name: 'ban: upload gmail messages collection POST', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/upload/gmail/v1/users/me/messages', body: {} }), rules: MATCH_ALL, rule: /messages-collection-post/ },
  { name: 'ban: gmail watch', req: () => ({ method: 'POST', url: `${GMAIL}/watch`, body: {} }), rules: MATCH_ALL, rule: /gmail-watch/ },
  { name: 'ban: gmail stop', req: () => ({ method: 'POST', url: `${GMAIL}/stop`, body: {} }), rules: MATCH_ALL, rule: /gmail-watch/ },

  // H4: path tricks.
  { name: 'trick: send%20', req: () => ({ method: 'POST', url: `${GMAIL}/messages/send%20`, body: {} }), rules: MATCH_ALL, rule: /gmail-send/ },
  { name: 'trick: x:send%20', req: () => ({ method: 'POST', url: `${GMAIL}/drafts/x:send%20`, body: {} }), rules: MATCH_ALL, rule: /custom-method|gmail-send/ },
  { name: 'trick: send;x=1', req: () => ({ method: 'POST', url: `${GMAIL}/messages/send;x=1`, body: {} }), rules: MATCH_ALL, rule: /matrix-param/ },
  { name: 'trick: messages;x/send', req: () => ({ method: 'POST', url: `${GMAIL}/messages;x/send`, body: {} }), rules: MATCH_ALL, rule: /matrix-param/ },
  { name: 'trick: encoded ; (%3B)', req: () => ({ method: 'POST', url: `${GMAIL}/drafts%3Bx`, body: {} }), rules: MATCH_ALL, rule: /matrix-param/ },
  { name: 'trick: trash%20 in drive', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files/abc/trash%20', body: {} }), rules: MATCH_ALL, rule: /trash/ },
  ...['access_token', 'key', 'oauth_token', 'apikey', 'bearer_token', 'upload_protocol', 'ACCESS_TOKEN', 'Key'].map((k): Reject => ({
    name: `query key ${k}`,
    req: () => ({ method: 'GET', url: URL_WRITE, query: { [k]: 'x' } }),
    rules: MATCH_ALL,
    rule: /auth-query/,
  })),

  // H4: scoped segment bans still apply on Drive and Calendar.
  { name: 'ban: drive files/{id}/trash', req: () => ({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files/abc/trash', body: {} }), rules: MATCH_ALL, rule: /trash/ },
  { name: 'ban: calendar import', req: () => ({ method: 'POST', url: `${CAL}/events/import`, query: NONE, body: {} }), rules: MATCH_ALL, rule: /import/ },

  // H4: rule hygiene, enforced by checkRequest itself.
  ...([
    ['unanchored start', { path: /\/drive\/v3\/files$/ }],
    ['unanchored end', { path: /^\/drive\/v3\/files/ }],
    ['global flag', { path: /^\/drive\/v3\/files$/g }],
    ['sticky flag', { path: /^\/drive\/v3\/files$/y }],
    ['top-level alternation', { path: /^\/drive\/v3\/files|\/x$/ }],
    ['escaped trailing $', { path: /^\/drive\/v3\/files\$/ }],
    ['missing allowedQuery', { path: /^\/drive\/v3\/files$/, allowedQuery: undefined }],
  ] as const).map(([name, over]): Reject => ({
    name: `bad rule: ${name}`,
    req: () => ({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files' }),
    rules: [{ id: 'bad', product: 'drive', method: 'GET', host: HOST, allowedQuery: [], ...over } as unknown as EndpointRule],
    rule: /bad-rule/,
  })),
];

describe('GoogleHttp guardrails: rejections never reach fetch', () => {
  it.each(REJECTIONS.map((r) => [r.name, r] as const))('%s', async (_n, r) => {
    const { http, calls } = setup([res(200), res(200)], { rules: r.rules ?? TEST_RULES });
    const err = await http.json(r.req() as Req).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'expected a rejection').toBeInstanceOf(GuardrailError);
    if (r.rule) expect((err as GuardrailError).rule).toMatch(r.rule);
    expect(calls).toHaveLength(0);
  });

  it('does not even fetch an access token for a rejected request', async () => {
    let tokenCalls = 0;
    const http = createGoogleHttp({
      getAccessToken: async () => {
        tokenCalls++;
        return TOKEN;
      },
      fetchImpl: (() => {
        throw new Error('should not fetch');
      }) as unknown as typeof fetch,
      rules: TEST_RULES,
    });
    await expect(http.json({ method: 'GET', url: 'https://evil.example/x' })).rejects.toBeInstanceOf(GuardrailError);
    expect(tokenCalls).toBe(0);
  });

  it('denies everything with the default (empty) rule set', async () => {
    expect(ENDPOINT_RULES).toEqual([]);
    const calls: unknown[] = [];
    const http = createGoogleHttp({
      getAccessToken: async () => TOKEN,
      fetchImpl: (async (...a: unknown[]) => {
        calls.push(a);
        return res(200);
      }) as unknown as typeof fetch,
    });
    await expect(http.json(get)).rejects.toBeInstanceOf(GuardrailError);
    await expect(http.json({ method: 'GET', url: URL_WRITE })).rejects.toMatchObject({ rule: 'no-matching-rule' });
    expect(calls).toHaveLength(0);
  });

  it('error messages carry the rule and never the body, query values or token', async () => {
    const { http } = setup([]);
    const err = (await http
      .json({ method: 'POST', url: URL_WRITE, query: { q: QUERY_MARKER }, body: { attendees: [BODY_MARKER] } })
      .catch((e: unknown) => e)) as GuardrailError;
    expect(err.rule).toBe('hard-ban/attendees');
    for (const m of [TOKEN, QUERY_MARKER, BODY_MARKER]) expect(err.message).not.toContain(m);
  });
});

describe('GoogleHttp guardrails: allowed requests', () => {
  it('lets a matching GET through, building the URL from the parsed parts', async () => {
    const { http, calls } = setup([res(200, { ok: 1 })]);
    await http.json({ method: 'GET', url: URL_WRITE, query: { fields: 'id,name' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_WRITE}?fields=id%2Cname`);
  });

  it('allows SPAM in addLabelIds (only TRASH is blocked)', async () => {
    const { http, calls } = setup([res(200, {})]);
    await http.json({ method: 'POST', url: URL_WRITE, body: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } });
    expect(calls).toHaveLength(1);
  });

  it('allows a Calendar write with sendUpdates=none', async () => {
    const { http, calls } = setup([res(200, {})]);
    await http.json({ method: 'POST', url: URL_OK, query: { sendUpdates: 'none' }, body: { summary: 's' } });
    expect(calls).toHaveLength(1);
  });

  it('allows percent-encoded ids such as calendar ids containing @', async () => {
    const rules: EndpointRule[] = [
      { id: 'cal-get', product: 'calendar', method: 'GET', host: HOST, path: /^\/calendar\/v3\/calendars\/[^/]+\/events$/, allowedQuery: [] },
    ];
    const { http, calls } = setup([res(200, {})], { rules });
    await http.json({ method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/a%40b.co/events' });
    expect(calls).toHaveLength(1);
  });

  it('enforces a rule allowedQuery, requiredQuery and checkBody', async () => {
    const rules: EndpointRule[] = [
      {
        id: 'strict',
        product: 'drive',
        method: 'POST',
        host: HOST,
        path: /^\/drive\/v3\/files$/,
        allowedQuery: ['fields'],
        requiredQuery: { supportsAllDrives: 'true' },
        checkBody: (b) => ((b as { name?: unknown })?.name === 'bad' ? 'name is bad' : null),
      },
    ];
    const url = 'https://www.googleapis.com/drive/v3/files';
    const ok = setup([res(200, {})], { rules });
    await ok.http.json({ method: 'POST', url, query: { supportsAllDrives: true, fields: 'id' }, body: { name: 'fine' } });
    expect(ok.calls).toHaveLength(1);

    const cases: [Req, RegExp][] = [
      [{ method: 'POST', url, query: { supportsAllDrives: true, extra: 1 }, body: {} }, /not allowed/],
      [{ method: 'POST', url, query: { fields: 'id' }, body: {} }, /must be "true"/],
      [{ method: 'POST', url, query: { supportsAllDrives: 'false' }, body: {} }, /must be "true"/],
      [{ method: 'POST', url, query: { supportsAllDrives: true }, body: { name: 'bad' } }, /name is bad/],
    ];
    for (const [req, why] of cases) {
      const s = setup([res(200)], { rules });
      await expect(s.http.json(req)).rejects.toMatchObject({ rule: 'strict', message: expect.stringMatching(why) });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('snapshots inputs once: a getter-based method cannot change after the check', async () => {
    let reads = 0;
    const req = {
      get method() {
        reads++;
        return 'GET' as const;
      },
      url: URL_WRITE,
    };
    const { http, calls } = setup([res(200, {})]);
    await http.json(req);
    expect(reads).toBe(1);
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('sends exactly the body that was checked (serialised once)', async () => {
    let n = 0;
    const body = { toJSON: () => (n++ === 0 ? { ok: 1 } : { attendees: [] }) };
    const { http, calls } = setup([res(200, {})]);
    await http.json({ method: 'POST', url: URL_WRITE, body });
    expect(n).toBe(1);
    expect(calls[0]!.init.body).toBe('{"ok":1}');
  });
});

describe('H4 guard scoping', () => {
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const rules: EndpointRule[] = [
    { id: 't-sheets', product: 'sheets', method: 'GET', host: 'sheets.googleapis.com', path: /^\/v4\/spreadsheets\/[^/]+\/values\/.+$/, allowedQuery: [] },
    { id: 't-fb', product: 'calendar', method: 'POST', host: HOST, path: /^\/calendar\/v3\/freeBusy$/, allowedQuery: [] },
    { id: 't-gm-drafts', product: 'gmail', method: 'POST', host: 'gmail.googleapis.com', path: /^\/gmail\/v1\/users\/[^/]+\/drafts$/, allowedQuery: [] },
    { id: 't-ev', product: 'calendar', method: 'POST', host: HOST, path: /^\/calendar\/v3\/calendars\/[^/]+\/events$/, allowedQuery: ['sendUpdates'] },
  ];

  it('a Sheets range named Trash or Import passes the guards', () => {
    for (const range of ['Trash!A1:B2', 'Import!A1:B2', 'untrash!A1']) {
      expect(checkRequest(rules, { method: 'GET', url: `${SHEETS}/s1/values/${range}` })).toEqual({ ok: true });
    }
  });

  it('batch and acl stay banned on Sheets paths', () => {
    expect(checkRequest(MATCH_ALL, { method: 'GET', url: `${SHEETS}/s1/values/batch` })).toMatchObject({ ok: false });
    expect(checkRequest(MATCH_ALL, { method: 'GET', url: `${SHEETS}/s1/acl` })).toMatchObject({ ok: false });
  });

  it('POST freeBusy without sendUpdates passes the guards', () => {
    expect(checkRequest(rules, { method: 'POST', url: 'https://www.googleapis.com/calendar/v3/freeBusy', body: { timeMin: 'a' } })).toEqual({ ok: true });
  });

  it('an events POST without sendUpdates is still rejected, with sendUpdates=none it passes', () => {
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    expect(checkRequest(rules, { method: 'POST', url, body: {} })).toMatchObject({ ok: false, rule: 'hard-ban/calendar-send-updates' });
    expect(checkRequest(rules, { method: 'POST', url: `${url}/e1`, body: {} })).toMatchObject({ ok: false });
    expect(checkRequest(rules, { method: 'POST', url, query: { sendUpdates: 'none' }, body: {} })).toEqual({ ok: true });
  });

  it('sendUpdates values other than none are banned on every path', () => {
    expect(checkRequest(rules, { method: 'POST', url: 'https://www.googleapis.com/calendar/v3/freeBusy', query: { sendUpdates: 'all' }, body: {} })).toMatchObject({ ok: false, rule: 'hard-ban/send-updates' });
  });

  it('Gmail drafts POST stays allowed; messages GET list is not a collection POST', () => {
    expect(checkRequest(rules, { method: 'POST', url: `${GMAIL}/drafts`, body: { message: { raw: 'x' } } })).toEqual({ ok: true });
    expect(checkRequest(MATCH_ALL, { method: 'GET', url: `${GMAIL}/messages` })).toEqual({ ok: true });
  });
});

describe('ENDPOINT_RULES hygiene (every phase)', () => {
  it('every rule is anchored, stateless, has allowedQuery, unique id and an allowed method', () => {
    const ids = new Set<string>();
    for (const r of ENDPOINT_RULES) {
      expect(r.path.source.startsWith('^'), `${r.id}: path must start with ^`).toBe(true);
      expect(r.path.source.endsWith('$'), `${r.id}: path must end with $`).toBe(true);
      expect(r.path.flags.includes('g') || r.path.flags.includes('y'), `${r.id}: no g or y flag`).toBe(false);
      expect(Array.isArray(r.allowedQuery), `${r.id}: allowedQuery must be an array`).toBe(true);
      expect(ids.has(r.id), `duplicate id ${r.id}`).toBe(false);
      ids.add(r.id);
      expect(['GET', 'POST', 'PATCH', 'PUT']).toContain(r.method);
    }
  });
});

describe('errors helpers', () => {
  it('isInvalidGrant', () => {
    expect(isInvalidGrant({ error: 'invalid_grant', error_description: 'x' })).toBe(true);
    expect(isInvalidGrant('{"error":"invalid_grant"}')).toBe(true);
    expect(isInvalidGrant({ error: 'invalid_client' })).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant('nope')).toBe(false);
  });
});
