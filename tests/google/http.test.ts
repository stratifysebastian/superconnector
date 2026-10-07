import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@/core/contracts/tool';
import { ProviderError } from '@/core/errors';
import { GoogleAuthError, isInvalidGrant } from '@/google/errors';
import { createGoogleHttp } from '@/google/http';

const URL_OK = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
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
      url: URL_OK,
      query: { a: 1, b: undefined, c: true },
      body: { x: 1 },
    });
    expect(out).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe(`${URL_OK}?a=1&c=true`);
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

  it('produces timeout when the request hangs', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const http = createGoogleHttp({ getAccessToken: async () => TOKEN, fetchImpl, timeoutMs: 20 });
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

describe('errors helpers', () => {
  it('isInvalidGrant', () => {
    expect(isInvalidGrant({ error: 'invalid_grant', error_description: 'x' })).toBe(true);
    expect(isInvalidGrant('{"error":"invalid_grant"}')).toBe(true);
    expect(isInvalidGrant({ error: 'invalid_client' })).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant('nope')).toBe(false);
  });
});
