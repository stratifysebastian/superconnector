import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LogEvent } from '@/core/contracts/tool';
import { QUICKBOOKS_SCOPE } from '@/core/products';
import { createCipher, hashToken } from '@/lib/crypto';
import { parseEnv } from '@/lib/env';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore, type MemoryStore } from '@/store/memory';

const h = vi.hoisted(() => ({ session: null as unknown, ctx: null as unknown }));
vi.mock('@/auth/session', () => ({ getAdminSession: async () => h.session }));
vi.mock('@/server/context', async (orig) => ({
  ...(await orig<typeof import('@/server/context')>()),
  getServerContext: async () => h.ctx,
}));

import { GET as connectGET } from '@/app/api/intuit/connect/route';
import { GET as callbackGET } from '@/app/api/intuit/callback/route';
import { GET as googleConnectGET } from '@/app/api/google/connect/route';

const BASE = 'http://localhost:3000';
const REFRESH = 'intuit-refresh-AAA111';
const ACCESS = 'intuit-access-BBB222';
const CODE = 'intuit-auth-code-CCC333';
const CLIENT_SECRET = 'intuit-client-secret-DDD444';
const REALM = '9130350000';
const NAME = 'Acme Widgets Canada Inc';
const EMAIL = 'Owner@Acme-Widgets.Example';

const logs: LogEvent[] = [];
const capture = {
  info: (e: LogEvent) => void logs.push(e),
  warn: (e: LogEvent) => void logs.push(e),
  error: (e: LogEvent) => void logs.push(e),
};

let ctx: ServerContext;
let store: MemoryStore;
let orgId: string;
let googleOrgId: string;
let fetchMock: ReturnType<typeof vi.fn>;
let tokenStatus: number;
let infoStatus: number;
let info: Record<string, unknown>;

async function setup(extraEnv: Record<string, string> = {}) {
  logs.length = 0;
  h.session = { email: 'admin@stratify.example', expiresAt: Date.now() + 1e6 };
  ctx = await createServerContext({
    store: createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64'))),
    env: parseEnv({ GOOGLE_MODE: 'mock', STORE: 'memory', ...extraEnv }),
    log: capture,
    seedMock: false,
  });
  store = ctx.store as MemoryStore;
  orgId = await store.orgClients.upsert({ provider: 'intuit', label: 'acme-ca', clientId: 'intuit-client-id', clientSecret: CLIENT_SECRET });
  googleOrgId = await store.orgClients.upsert({ label: 'g', clientId: 'gid', clientSecret: 'gs', workspaceDomain: 'g.example' });
  h.ctx = ctx;
  tokenStatus = 200;
  infoStatus = 200;
  info = { CompanyInfo: { CompanyName: NAME, Email: { Address: EMAIL } } };
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('https://oauth.platform.intuit.com/')) {
      return new Response(JSON.stringify(tokenStatus === 200 ? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } : { error: 'invalid_grant' }), { status: tokenStatus });
    }
    return new Response(JSON.stringify(infoStatus === 200 ? info : { Fault: {} }), { status: infoStatus });
  });
  vi.stubGlobal('fetch', fetchMock);
}
beforeEach(() => setup());

async function startState(accountId?: string): Promise<string> {
  const qs = `org=${orgId}` + (accountId ? `&account=${accountId}` : '');
  const res = await connectGET(new NextRequest(`${BASE}/api/intuit/connect?${qs}`));
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}
const callback = (qs: string) => callbackGET(new NextRequest(`${BASE}/api/intuit/callback?${qs}`));
const loc = (r: Response) => new URL(r.headers.get('location')!);
const errorOf = (r: Response) => loc(r).searchParams.get('error');
const intuitAccounts = async () => (await store.accounts.list()).filter((a) => a.provider === 'intuit');

describe('connect route', () => {
  it('redirects to sign-in without a session', async () => {
    h.session = null;
    const res = await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=${orgId}`));
    expect(loc(res).pathname + loc(res).search).toBe('/signin?next=/connect');
  });

  it('rejects cross-site navigations', async () => {
    const res = await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=${orgId}`, { headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(res.status).toBe(403);
  });

  it('404s for an unknown org and for a Google org client', async () => {
    expect((await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=nope`))).status).toBe(404);
    expect((await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=${googleOrgId}`))).status).toBe(404);
    // and the Google route refuses the Intuit client
    expect((await googleConnectGET(new NextRequest(`${BASE}/api/google/connect?org=${orgId}`))).status).toBe(404);
  });

  it('404s for a reconnect of a Google account', async () => {
    const g = await store.accounts.upsertOnConnect({ provider: 'google', email: 'a@g.example', label: 'g', orgClientId: googleOrgId, grantedScopes: [] });
    expect((await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=${orgId}&account=${g.id}`))).status).toBe(404);
  });

  it('redirects to Intuit with the documented parameters; stores only the state hash, bound to the org', async () => {
    const res = await connectGET(new NextRequest(`${BASE}/api/intuit/connect?org=${orgId}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const u = loc(res);
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('client_id')).toBe('intuit-client-id');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/api/intuit/callback`);
    expect(u.toString()).not.toContain(CLIENT_SECRET);
    const state = u.searchParams.get('state')!;
    expect(JSON.stringify(store._dump())).not.toContain(state);
    expect(await store.oauth.consumeState(hashToken(state))).toMatchObject({ orgClientId: orgId });
  });
});

describe('callback route', () => {
  it('connects a company: realm, name, email, label, encrypted tokens, active', async () => {
    const state = await startState();
    const res = await callback(`code=${CODE}&realmId=${REALM}&state=${state}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(loc(res).pathname).toBe('/connect');
    expect(loc(res).searchParams.get('connected')).toBe('acme-ca');
    const [a] = await intuitAccounts();
    expect(a).toMatchObject({
      provider: 'intuit', realmId: REALM, label: 'acme-ca', email: 'owner@acme-widgets.example', companyName: NAME,
      status: 'active', grantedScopes: [QUICKBOOKS_SCOPE], orgClientId: orgId,
    });
    expect(await store.tokens.getRefreshToken(a!.id)).toBe(REFRESH);
    expect((await store.tokens.getCachedAccess(a!.id))?.token).toBe(ACCESS);
    const dump = JSON.stringify(store._dump());
    expect(dump).not.toContain(REFRESH);
    expect(dump).not.toContain(ACCESS);
    expect(dump).not.toContain(CLIENT_SECRET);
  });

  it('exchanges the code with Basic auth, then reads CompanyInfo from the live host with minorversion', async () => {
    const state = await startState();
    await callback(`code=${CODE}&realmId=${REALM}&state=${state}`);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect((tokenInit.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    const body = new URLSearchParams(tokenInit.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe(CODE);
    expect(body.get('redirect_uri')).toBe(`${BASE}/api/intuit/callback`);
    const [infoUrl, infoInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const u = new URL(infoUrl);
    expect(u.host).toBe('quickbooks.api.intuit.com');
    expect(u.pathname).toBe(`/v3/company/${REALM}/companyinfo/${REALM}`);
    expect(u.searchParams.get('minorversion')).toBeTruthy();
    expect((infoInit.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
  });

  it('uses the sandbox host when INTUIT_ENV=sandbox', async () => {
    await setup({ INTUIT_ENV: 'sandbox' });
    const state = await startState();
    await callback(`code=${CODE}&realmId=${REALM}&state=${state}`);
    expect(new URL((fetchMock.mock.calls[1] as [string])[0]).host).toBe('sandbox-quickbooks.api.intuit.com');
  });

  it('falls back to a synthetic email when CompanyInfo has none', async () => {
    info = { CompanyInfo: { CompanyName: NAME } };
    const state = await startState();
    await callback(`code=${CODE}&realmId=${REALM}&state=${state}`);
    expect((await intuitAccounts())[0]!.email).toBe(`realm-${REALM}@intuit.local`);
  });

  it('the state is single use', async () => {
    const state = await startState();
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=${state}`))).toBeNull();
    fetchMock.mockClear();
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=${state}`))).toBe('state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an expired, unknown or missing state is refused before any network call', async () => {
    await store.oauth.saveState(hashToken('old'), { orgClientId: orgId, expiresAt: Date.now() - 1000 });
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=old`))).toBe('state');
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=unknown`))).toBe('state');
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}`))).toBe('state');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await intuitAccounts()).toHaveLength(0);
  });

  it('a state minted for a Google client is refused', async () => {
    await store.oauth.saveState(hashToken('gs'), { orgClientId: googleOrgId, expiresAt: Date.now() + 60_000 });
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=gs`))).toBe('state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the admin session and leaves the state unused', async () => {
    const state = await startState();
    h.session = null;
    const res = await callback(`code=${CODE}&realmId=${REALM}&state=${state}`);
    expect(loc(res).pathname).toBe('/signin');
    expect(await store.oauth.consumeState(hashToken(state))).not.toBeNull();
  });

  it('user denial, a missing realmId and a malformed realmId are plain errors', async () => {
    expect(errorOf(await callback(`error=access_denied&state=${await startState()}`))).toBe('denied');
    expect(errorOf(await callback(`code=${CODE}&state=${await startState()}`))).toBe('no_realm');
    expect(errorOf(await callback(`code=${CODE}&realmId=${encodeURIComponent('../x')}&state=${await startState()}`))).toBe('no_realm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed code exchange or CompanyInfo read saves nothing', async () => {
    tokenStatus = 400;
    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`))).toBe('exchange_failed');
    tokenStatus = 200;
    infoStatus = 404; // a 5xx would be retried with real timers

    expect(errorOf(await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`))).toBe('company_info');
    expect(await intuitAccounts()).toHaveLength(0);
    expect(JSON.stringify(store._dump())).not.toContain('"refreshEnc"');
  });

  describe('reconnect', () => {
    it('the same realmId reconnects the same account and reactivates it', async () => {
      await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`);
      const [a] = await intuitAccounts();
      await store.accounts.setStatus(a!.id, 'needs_reconnect');
      info = { CompanyInfo: { CompanyName: 'Acme Renamed', Email: { Address: EMAIL } } };
      const res = await callback(`code=${CODE}&realmId=${REALM}&state=${await startState(a!.id)}`);
      expect(loc(res).searchParams.get('connected')).toBe('acme-ca');
      const after = await intuitAccounts();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: a!.id, status: 'active', companyName: 'Acme Renamed' });
    });

    it('a different realmId is refused: nothing exchanged, nothing changed', async () => {
      await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`);
      const [a] = await intuitAccounts();
      await store.tokens.setRefreshToken(a!.id, 'keep-me-refresh');
      fetchMock.mockClear();
      const res = await callback(`code=${CODE}&realmId=7777777&state=${await startState(a!.id)}`);
      expect(errorOf(res)).toBe('wrong_company');
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await intuitAccounts();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ realmId: REALM, companyName: NAME });
      expect(await store.tokens.getRefreshToken(a!.id)).toBe('keep-me-refresh');
    });

    it('a second company with the same email is a separate account', async () => {
      await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`);
      await callback(`code=${CODE}&realmId=8888888&state=${await startState()}`);
      const list = await intuitAccounts();
      expect(list.map((a) => a.realmId)).toEqual([REALM, '8888888']);
      expect(list.map((a) => a.label)).toEqual(['acme-ca', 'acme-ca-2']);
    });
  });

  it('logs and audit hold no token, secret, name, email or realm', async () => {
    await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`);
    await callback(`code=${CODE}&realmId=${REALM}&state=bad`);
    tokenStatus = 400;
    await callback(`code=${CODE}&realmId=${REALM}&state=${await startState()}`);
    const text = JSON.stringify(logs) + JSON.stringify((store._dump() as { audit: unknown }).audit);
    for (const secret of [REFRESH, ACCESS, CODE, CLIENT_SECRET, NAME, EMAIL.toLowerCase(), REALM]) expect(text).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
  });
});
