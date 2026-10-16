import { describe, expect, it, vi } from 'vitest';
import { GuardrailError, ProviderError } from '../../src/core/errors';
import type { LogEvent } from '../../src/core/contracts/tool';
import {
  INTUIT_LIVE_HOST, INTUIT_MINOR_VERSION, INTUIT_RULES, INTUIT_SANDBOX_HOST, checkIntuitRequest, companyPath, type IntuitEnv, type IntuitRule,
} from '../../src/intuit/endpoints';
import { createIntuitHttp } from '../../src/intuit/http';
import { fetchCompanyInfo } from '../../src/intuit/quickbooks';

const REALM = '9130350000';
const TOKEN = 'qb-access-token-SECRET123';
const INFO = { CompanyInfo: { CompanyName: 'Secret Name Inc', Email: { Address: 'owner@secret.example' } } };
const ok = (body: unknown = INFO) => new Response(JSON.stringify(body), { status: 200 });

function setup(over: { env?: IntuitEnv; responses?: Array<() => Response>; realmId?: string; rules?: IntuitRule[]; getAccessToken?: (force?: boolean) => Promise<string> } = {}) {
  const logs: LogEvent[] = [];
  const queue = [...(over.responses ?? [() => ok()])];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const fetchImpl = vi.fn(async (..._args: [string, RequestInit]) => (queue.length > 1 ? queue.shift()! : queue[0]!)());
  const sleeps: number[] = [];
  const http = createIntuitHttp({
    getAccessToken: over.getAccessToken ?? (async () => TOKEN),
    realmId: over.realmId ?? REALM,
    env: over.env ?? 'production',
    fetchImpl: fetchImpl as never,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    log: { info: (e) => void logs.push(e), warn: (e) => void logs.push(e), error: (e) => void logs.push(e) },
    ...(over.rules ? { rules: over.rules } : {}),
  });
  return { http, fetchImpl, logs, sleeps };
}
const info = (realm = REALM) => ({ method: 'GET' as const, path: companyPath(realm, `companyinfo/${realm}`) });

describe('IntuitHttp policy', () => {
  it('allows CompanyInfo for the account, on the live host, with minorversion and a bearer token', async () => {
    const { http, fetchImpl } = setup();
    expect((await http.json<typeof INFO>(info())).CompanyInfo.CompanyName).toBe('Secret Name Inc');
    const [url, init] = fetchImpl.mock.calls[0]!;
    const u = new URL(url);
    expect(u.origin).toBe(`https://${INTUIT_LIVE_HOST}`);
    expect(u.pathname).toBe(`/v3/company/${REALM}/companyinfo/${REALM}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ minorversion: INTUIT_MINOR_VERSION });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
  });

  it('Q0 has exactly one rule: GET companyinfo/{realmId}', () => {
    expect(INTUIT_RULES.map((r) => `${r.method} ${r.template}`)).toEqual(['GET /v3/company/{realmId}/companyinfo/{realmId}']);
  });

  it('denies another realm, in the company segment or in the resource', async () => {
    const { http, fetchImpl } = setup();
    await expect(http.json(info('1111111111'))).rejects.toBeInstanceOf(GuardrailError);
    await expect(http.json({ method: 'GET', path: companyPath(REALM, 'companyinfo/1111111111') })).rejects.toBeInstanceOf(GuardrailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown resource', `/v3/company/${REALM}/invoice/1`],
    ['no company', '/v3/company'],
    ['wrong prefix', `/v2/company/${REALM}/companyinfo/${REALM}`],
    ['other api', '/v3/other'],
    ['dot segments', `/v3/company/${REALM}/../${REALM}/companyinfo/${REALM}`],
    ['encoded slash', `/v3/company/${REALM}/companyinfo%2F${REALM}`],
    ['empty segment', `/v3/company/${REALM}//companyinfo/${REALM}`],
    ['query in path', `/v3/company/${REALM}/companyinfo/${REALM}?x=1`],
    ['trailing path', `/v3/company/${REALM}/companyinfo/${REALM}/x`],
    ['full url', `https://evil.example/v3/company/${REALM}/companyinfo/${REALM}`],
  ])('denies by default: %s', async (_n, path) => {
    const { http, fetchImpl } = setup();
    await expect(http.json({ method: 'GET', path })).rejects.toBeInstanceOf(GuardrailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies every verb but GET', async () => {
    const { http, fetchImpl } = setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get']) {
      await expect(http.json({ ...info(), method } as never)).rejects.toBeInstanceOf(GuardrailError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies query keys the rule does not list, including minorversion from the caller', async () => {
    const { http, fetchImpl } = setup();
    await expect(http.json({ ...info(), query: { query: 'select * from Invoice' } })).rejects.toBeInstanceOf(GuardrailError);
    await expect(http.json({ ...info(), query: { minorversion: '1' } })).rejects.toBeInstanceOf(GuardrailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows only a listed query key, and still appends minorversion', async () => {
    const rule: IntuitRule = { ...INTUIT_RULES[0]!, id: 'test.rule', allowedQuery: ['reportDate'] };
    const { http, fetchImpl } = setup({ rules: [rule] });
    await http.json({ ...info(), query: { reportDate: '2026-01-01', skipped: undefined } });
    expect(Object.fromEntries(new URL(fetchImpl.mock.calls[0]![0]).searchParams)).toEqual({ reportDate: '2026-01-01', minorversion: INTUIT_MINOR_VERSION });
  });

  it('the sandbox host is used only when INTUIT_ENV=sandbox', async () => {
    const sb = setup({ env: 'sandbox' });
    await sb.http.json(info());
    expect(new URL(sb.fetchImpl.mock.calls[0]![0]).hostname).toBe(INTUIT_SANDBOX_HOST);
    const prod = setup();
    await prod.http.json(info());
    expect(new URL(prod.fetchImpl.mock.calls[0]![0]).hostname).toBe(INTUIT_LIVE_HOST);
  });

  it('the policy itself rejects unknown hosts, and the sandbox host outside sandbox', () => {
    const base = { method: 'GET', path: companyPath(REALM, `companyinfo/${REALM}`), realmId: REALM };
    expect(checkIntuitRequest(INTUIT_RULES, { ...base, host: INTUIT_LIVE_HOST, env: 'production' }).ok).toBe(true);
    expect(checkIntuitRequest(INTUIT_RULES, { ...base, host: INTUIT_SANDBOX_HOST, env: 'sandbox' }).ok).toBe(true);
    for (const host of [INTUIT_SANDBOX_HOST, 'evil.example', 'quickbooks.api.intuit.com.evil.example', 'oauth.platform.intuit.com', 'www.googleapis.com', undefined]) {
      expect(checkIntuitRequest(INTUIT_RULES, { ...base, host, env: 'production' }).ok).toBe(false);
    }
    expect(checkIntuitRequest(INTUIT_RULES, { ...base, host: INTUIT_LIVE_HOST, env: 'sandbox' }).ok).toBe(false);
  });

  it('refuses to work for an account without a valid realmId', async () => {
    const { http, fetchImpl } = setup({ realmId: '../x' });
    await expect(http.json(info('../x'))).rejects.toBeInstanceOf(GuardrailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetchCompanyInfo returns the CompanyInfo object', async () => {
    const { http } = setup();
    expect((await fetchCompanyInfo(http, REALM)).CompanyName).toBe('Secret Name Inc');
  });
});

describe('IntuitHttp transport', () => {
  it('401 refreshes once with force, then retries', async () => {
    const getAccessToken = vi.fn(async (force?: boolean) => (force ? 'fresh-token' : 'stale-token'));
    const { http, fetchImpl } = setup({ getAccessToken, responses: [() => new Response('{}', { status: 401 }), () => ok()] });
    await http.json(info());
    expect(getAccessToken.mock.calls).toEqual([[], [true]]);
    expect((fetchImpl.mock.calls[1]![1].headers as Record<string, string>).authorization).toBe('Bearer fresh-token');
  });

  it('a second 401 is needs_reconnect', async () => {
    const { http, fetchImpl } = setup({ responses: [() => new Response('{}', { status: 401 })] });
    await expect(http.json(info())).rejects.toMatchObject({ kind: 'needs_reconnect' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a refresh that reports needs_reconnect surfaces it', async () => {
    const getAccessToken = async (force?: boolean) => {
      if (force) throw new ProviderError('needs_reconnect', 'gone');
      return TOKEN;
    };
    const { http } = setup({ getAccessToken, responses: [() => new Response('{}', { status: 401 })] });
    await expect(http.json(info())).rejects.toMatchObject({ kind: 'needs_reconnect' });
  });

  it('retries 429 and 5xx on GET with backoff, honouring Retry-After', async () => {
    const { http, fetchImpl, sleeps } = setup({
      responses: [() => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }), () => new Response('{}', { status: 503 }), () => ok()],
    });
    await http.json(info());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 500]);
  });

  it('gives up after 3 retries', async () => {
    const r = setup({ responses: [() => new Response('{}', { status: 429 })] });
    await expect(r.http.json(info())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(4);
    const s = setup({ responses: [() => new Response('{}', { status: 500 })] });
    await expect(s.http.json(info())).rejects.toMatchObject({ kind: 'upstream_error' });
  });

  it.each([[403, 'missing_scope'], [404, 'not_found'], [400, 'upstream_error']])('maps HTTP %i to %s without retrying', async (status, kind) => {
    const { http, fetchImpl } = setup({ responses: [() => new Response(JSON.stringify({ Fault: { Error: [{ Detail: 'Secret Name Inc' }] } }), { status })] });
    const err = await http.json(info()).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe(kind);
    expect((err as Error).message).not.toContain('Secret Name');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a network failure is an upstream error', async () => {
    const http = createIntuitHttp({ getAccessToken: async () => TOKEN, realmId: REALM, env: 'production', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as never });
    await expect(http.json(info())).rejects.toMatchObject({ kind: 'upstream_error' });
  });

  it('logs hold method, path template and status, and no token, name, email or realm', async () => {
    const { http, logs } = setup();
    await http.json(info());
    const r = setup({ responses: [() => new Response('{}', { status: 404 })] });
    await r.http.json(info()).catch(() => undefined);
    for (const l of [...logs, ...r.logs]) {
      expect(l).toMatchObject({ msg: 'intuit_http', method: 'GET', path: '/v3/company/{realmId}/companyinfo/{realmId}' });
    }
    const text = JSON.stringify([...logs, ...r.logs]);
    for (const secret of [TOKEN, 'Secret Name', 'owner@secret.example', REALM]) expect(text).not.toContain(secret);
    expect(logs[0]).toMatchObject({ outcome: 'ok', status: 200 });
    expect(r.logs[0]).toMatchObject({ outcome: 'not_found', status: 404 });
  });
});
