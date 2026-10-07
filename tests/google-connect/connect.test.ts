import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LogEvent } from '@/core/contracts/tool';
import { ALL_SCOPES } from '@/core/products';
import { ProviderError } from '@/core/errors';
import { buildGoogleAuthUrl, derivePkceVerifier, pkceChallenge } from '@/google/oauth';
import { createTokenManager } from '@/google/token-manager';
import { hashToken } from '@/lib/crypto';
import { parseEnv } from '@/lib/env';
import { createServerContext, type ServerContext } from '@/server/context';
import { createCipher } from '@/lib/crypto';
import { createMemoryStore, type MemoryStore } from '@/store/memory';

const h = vi.hoisted(() => ({ session: null as unknown, ctx: null as unknown }));
vi.mock('@/auth/session', () => ({ getAdminSession: async () => h.session }));
vi.mock('@/server/context', async (orig) => ({
  ...(await orig<typeof import('@/server/context')>()),
  getServerContext: async () => h.ctx,
}));

import { GET as connectGET } from '@/app/api/google/connect/route';
import { GET as callbackGET } from '@/app/api/google/callback/route';

const SECRET = 'x'.repeat(40);
const REFRESH = 'seeded-refresh-token-AAA111';
const ACCESS = 'seeded-access-token-BBB222';
const CODE = 'seeded-auth-code-CCC333';
const BASE = 'http://localhost:3000';

const logs: LogEvent[] = [];
const capture = {
  info: (e: LogEvent) => void logs.push(e),
  warn: (e: LogEvent) => void logs.push(e),
  error: (e: LogEvent) => void logs.push(e),
};

function idToken(over: Record<string, unknown> = {}): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b({
    iss: 'https://accounts.google.com',
    aud: 'fake-client-id-stratify',
    sub: '123',
    email: 'Seb@Stratify.Example',
    email_verified: true,
    hd: 'stratify.example',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  })}.sig`;
}

let ctx: ServerContext;
let store: MemoryStore;
let orgId: string;
let tokenResponse: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  logs.length = 0;
  h.session = { email: 'seb@stratify.example', expiresAt: Date.now() + 1e6 };
  const fresh = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
  ctx = await createServerContext({
    store: fresh,
    env: parseEnv({ GOOGLE_MODE: 'mock', STORE: 'memory', SESSION_SECRET: SECRET }),
    log: capture,
    seedMock: false,
  });
  store = ctx.store as MemoryStore;
  orgId = await store.orgClients.upsert({
    label: 'stratify',
    clientId: 'fake-client-id-stratify',
    clientSecret: 'fake-client-secret-stratify',
    workspaceDomain: 'stratify.example',
  });
  h.ctx = ctx;
  tokenResponse = {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    scope: ALL_SCOPES.join(' '),
    id_token: idToken(),
  };
  fetchMock = vi.fn(async () => new Response(JSON.stringify(tokenResponse), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

async function startState(accountId?: string): Promise<string> {
  const qs = `org=${orgId}` + (accountId ? `&account=${accountId}` : '');
  const res = await connectGET(new NextRequest(`${BASE}/api/google/connect?${qs}`));
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}
const callback = (qs: string) => callbackGET(new NextRequest(`${BASE}/api/google/callback?${qs}`));
const loc = (r: Response) => new URL(r.headers.get('location')!);

describe('auth URL', () => {
  it('has every required parameter and no secret', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        orgClient: { clientId: 'cid', workspaceDomain: 'stratify.example' },
        redirectUri: `${BASE}/api/google/callback`,
        state: 's',
        codeChallenge: pkceChallenge(derivePkceVerifier('s', SECRET)),
      }),
    );
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(q.get('scope')).toBe(ALL_SCOPES.join(' '));
    expect(q.get('hd')).toBe('stratify.example');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.toString()).not.toMatch(/secret/i);
  });
});

describe('connect route', () => {
  it('redirects to sign-in without a session', async () => {
    h.session = null;
    const res = await connectGET(new NextRequest(`${BASE}/api/google/connect?org=${orgId}`));
    expect(res.status).toBe(302);
    expect(loc(res).pathname + loc(res).search).toBe('/signin?next=/connect');
  });
  it('404s for an unknown org', async () => {
    const res = await connectGET(new NextRequest(`${BASE}/api/google/connect?org=nope`));
    expect(res.status).toBe(404);
  });
  it('stores only the state hash and redirects to Google, no-store', async () => {
    const res = await connectGET(new NextRequest(`${BASE}/api/google/connect?org=${orgId}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const state = loc(res).searchParams.get('state')!;
    expect(JSON.stringify((store as MemoryStore)._dump())).not.toContain(state);
    expect(loc(res).searchParams.get('redirect_uri')).toBe(`${BASE}/api/google/callback`);
    expect(await store.oauth.consumeState(hashToken(state))).toMatchObject({ orgClientId: orgId });
  });
});

describe('callback', () => {
  it('connects the account, encrypts the refresh token, leaks nothing in the redirect', async () => {
    const state = await startState();
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(302);
    expect(loc(res).pathname).toBe('/connect');
    expect(loc(res).searchParams.get('connected')).toBe('stratify');
    expect(loc(res).searchParams.get('missing')).toBeNull();
    const location = res.headers.get('location')!;
    for (const secret of [REFRESH, ACCESS, CODE, 'seb@stratify.example', 'stratify.example']) {
      expect(location).not.toContain(secret);
    }
    const [acct] = await store.accounts.list();
    expect(acct).toMatchObject({ label: 'stratify', status: 'active', email: 'seb@stratify.example' });
    expect(await store.tokens.getRefreshToken(acct!.id)).toBe(REFRESH);
    expect(JSON.stringify(store._dump())).not.toContain(REFRESH);
    expect((await store.tokens.getCachedAccess(acct!.id))?.token).toBe(ACCESS);
    // code_verifier sent matches the challenge in the auth URL
    const sent = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(sent.get('code')).toBe(CODE);
    expect(sent.get('code_verifier')).toBe(derivePkceVerifier(state, SECRET));
    expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}`));
  });

  it.each([
    ['wrong hd', { hd: 'evil.example' }],
    ['wrong aud', { aud: 'other-client' }],
    ['unverified email', { email_verified: false }],
    ['expired id token', { exp: Math.floor(Date.now() / 1000) - 10 }],
  ])('rejects %s', async (_n, over) => {
    tokenResponse.id_token = idToken(over);
    const state = await startState();
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(loc(res).searchParams.get('error')).toBe('invalid_token');
    expect(await store.accounts.list()).toEqual([]);
  });

  it('rejects a replayed state', async () => {
    const state = await startState();
    await callback(`code=${CODE}&state=${state}`);
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(loc(res).searchParams.get('error')).toBe('state');
  });

  it('rejects an expired state', async () => {
    await store.oauth.saveState(hashToken('old'), { orgClientId: orgId, expiresAt: Date.now() - 1000 });
    const res = await callback(`code=${CODE}&state=old`);
    expect(loc(res).searchParams.get('error')).toBe('state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects reconnect as a different email', async () => {
    const first = await callback(`code=${CODE}&state=${await startState()}`);
    expect(loc(first).searchParams.get('connected')).toBe('stratify');
    const [acct] = await store.accounts.list();
    tokenResponse.id_token = idToken({ email: 'someone.else@stratify.example' });
    const res = await callback(`code=${CODE}&state=${await startState(acct!.id)}`);
    expect(loc(res).searchParams.get('error')).toBe('wrong_account');
    expect(res.headers.get('location')).not.toContain('someone.else');
  });

  it('rejects a response without a refresh token', async () => {
    delete tokenResponse.refresh_token;
    const res = await callback(`code=${CODE}&state=${await startState()}`);
    expect(loc(res).searchParams.get('error')).toBe('no_refresh_token');
    expect(await store.accounts.list()).toEqual([]);
  });

  it('still connects when scopes are missing and reports them', async () => {
    tokenResponse.scope = ALL_SCOPES.filter((s) => !s.includes('drive') && !s.includes('gmail')).join(' ');
    const res = await callback(`code=${CODE}&state=${await startState()}`);
    expect(loc(res).searchParams.get('connected')).toBe('stratify');
    expect(loc(res).searchParams.get('missing')).toBe('gmail,drive');
    expect(await store.accounts.list()).toHaveLength(1);
  });

  it('redirects to sign-in without a session', async () => {
    h.session = null;
    const res = await callback(`code=${CODE}&state=x`);
    expect(loc(res).pathname).toBe('/signin');
  });

  it('writes an audit entry on success', async () => {
    await callback(`code=${CODE}&state=${await startState()}`);
    const dump = JSON.stringify(store._dump());
    expect(dump).toContain('"connect"');
  });
});

describe('token manager', () => {
  async function setup(now: { t: number }, fetchImpl: typeof fetch) {
    const acct = await store.accounts.upsertOnConnect({
      provider: 'google',
      email: 'seb@stratify.example',
      label: 'stratify',
      orgClientId: orgId,
      grantedScopes: ALL_SCOPES,
    });
    await store.tokens.setRefreshToken(acct.id, REFRESH);
    const tm = createTokenManager({ store, fetchImpl, now: () => now.t, log: capture });
    return { acct, tm };
  }

  it('reuses a fresh cached token without fetching', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn();
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    await store.tokens.setCachedAccess(acct.id, 'cached', now.t + 120_000);
    expect(await tm.getAccessToken(acct)).toBe('cached');
    expect(f).not.toHaveBeenCalled();
  });

  it('refreshes once for 5 concurrent callers near expiry', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 }),
    );
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    await store.tokens.setCachedAccess(acct.id, 'stale', now.t + 30_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => tm.getAccessToken(acct)));
    expect(results).toEqual(Array(5).fill('fresh'));
    expect(f).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(await store.tokens.getCachedAccess(acct.id)).toEqual({ token: 'fresh', expiresAt: now.t + 3_600_000 });
  });

  it('forceRefresh ignores a fresh cache and calls the endpoint once', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'forced', expires_in: 3600 }), { status: 200 }),
    );
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    await store.tokens.setCachedAccess(acct.id, 'cached', now.t + 600_000);
    const r = await Promise.all([
      tm.getAccessToken(acct, { forceRefresh: true }),
      tm.getAccessToken(acct, { forceRefresh: true }),
    ]);
    expect(r).toEqual(['forced', 'forced']);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await store.tokens.getCachedAccess(acct.id))?.token).toBe('forced');
  });

  it('forceRefresh with invalid_grant flips the status', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    await store.tokens.setCachedAccess(acct.id, 'cached', now.t + 600_000);
    const err = await tm.getAccessToken(acct, { forceRefresh: true }).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('needs_reconnect');
    expect((await store.accounts.list())[0]!.status).toBe('needs_reconnect');
  });

  it('marks needs_reconnect on invalid_grant', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    const err = await tm.getAccessToken(acct).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('needs_reconnect');
    expect((err as ProviderError).message).toBe('STRATIFY account disconnected — reconnect at /connect');
    expect((await store.accounts.list())[0]!.status).toBe('needs_reconnect');
  });

  it('treats a missing refresh token as needs_reconnect and other failures as upstream_error', async () => {
    const now = { t: 1_000_000 };
    const f = vi.fn(async () => new Response('{"error":"server_error"}', { status: 500 }));
    const { acct, tm } = await setup(now, f as unknown as typeof fetch);
    const err = await tm.getAccessToken(acct).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('upstream_error');
    expect((err as ProviderError).message).not.toContain('server_error');
    const bare = await store.accounts.upsertOnConnect({
      provider: 'google',
      email: 'x@stratify.example',
      label: 'x',
      orgClientId: orgId,
      grantedScopes: [],
    });
    const err2 = await tm.getAccessToken(bare).catch((e: unknown) => e);
    expect((err2 as ProviderError).kind).toBe('needs_reconnect');
  });
});

describe('no leaks', () => {
  it('logs and redirects never contain seeded secrets', async () => {
    const locations: string[] = [];
    locations.push((await callback(`code=${CODE}&state=${await startState()}`)).headers.get('location')!);
    locations.push((await callback(`code=${CODE}&state=replayed`)).headers.get('location')!);
    delete tokenResponse.refresh_token;
    locations.push((await callback(`code=${CODE}&state=${await startState()}`)).headers.get('location')!);
    const all = JSON.stringify(logs) + locations.join('\n');
    for (const s of [REFRESH, ACCESS, CODE, 'fake-client-secret-stratify']) expect(all).not.toContain(s);
  });
});
