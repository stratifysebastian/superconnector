import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../src/core/contracts/account';
import type { LogEvent } from '../../src/core/contracts/tool';
import { ProviderError } from '../../src/core/errors';
import { QUICKBOOKS_SCOPE } from '../../src/core/products';
import { buildIntuitAuthUrl, exchangeIntuitCode, INTUIT_TOKEN_URL, startIntuitAuth } from '../../src/intuit/oauth';
import { createIntuitTokenManager } from '../../src/intuit/token-manager';
import { hashToken } from '../../src/lib/crypto';
import { createMemoryStore, type MemoryStore } from '../../src/store/memory';
import { fakeCipher } from '../store/conformance';

const BASE = 'https://mcp.example.test';
const R1 = 'refresh-one-AAA111';
const R2 = 'refresh-two-BBB222';
const R3 = 'refresh-three-CCC333';
const ACCESS = 'access-token-XXX999';

let store: MemoryStore;
let org: string;
let account: Account;
let logs: LogEvent[];
let now: number;
const log = {
  info: (e: LogEvent) => void logs.push(e),
  warn: (e: LogEvent) => void logs.push(e),
  error: (e: LogEvent) => void logs.push(e),
};

beforeEach(async () => {
  logs = [];
  now = 1_000_000;
  store = createMemoryStore(fakeCipher);
  org = await store.orgClients.upsert({ provider: 'intuit', label: 'stratify-ca', clientId: 'qb-client-id', clientSecret: 'qb-client-secret-ZZZ' });
  account = await store.accounts.upsertOnConnect({
    provider: 'intuit', email: 'realm-1@intuit.local', label: 'stratify-ca', orgClientId: org, grantedScopes: [QUICKBOOKS_SCOPE], realmId: '1234',
  });
  await store.tokens.setRefreshToken(account.id, R1);
});

const tokenBody = (over: Record<string, unknown> = {}) => ({ access_token: ACCESS, refresh_token: R2, expires_in: 3600, x_refresh_token_expires_in: 8726400, token_type: 'bearer', ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('authorize URL', () => {
  it('has the documented parameters and no secret', () => {
    const url = new URL(buildIntuitAuthUrl({ clientId: 'cid', redirectUri: `${BASE}/api/intuit/callback`, state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: `${BASE}/api/intuit/callback`,
      state: 'st',
    });
  });

  it('startIntuitAuth stores only the state hash, single use, expiring in 10 minutes', async () => {
    const t0 = Date.now();
    const url = new URL(
      await startIntuitAuth({ store, orgClientId: org, orgClient: { clientId: 'cid' }, redirectUri: `${BASE}/api/intuit/callback`, now: () => t0 }),
    );
    const state = url.searchParams.get('state')!;
    expect(JSON.stringify(store._dump())).not.toContain(state);
    const got = await store.oauth.consumeState(hashToken(state));
    expect(got).toEqual({ orgClientId: org, expiresAt: t0 + 10 * 60 * 1000 });
    expect(await store.oauth.consumeState(hashToken(state))).toBeNull(); // single use
  });
});

describe('code exchange', () => {
  it('posts form-encoded with Basic auth and returns the tokens', async () => {
    const fetchImpl = vi.fn(async () => json(tokenBody()));
    const t = await exchangeIntuitCode({
      client: { clientId: 'qb-client-id', clientSecret: 'qb-client-secret-ZZZ' }, code: 'the-code', redirectUri: `${BASE}/api/intuit/callback`, fetchImpl: fetchImpl as never,
    });
    expect(t).toEqual({ accessToken: ACCESS, refreshToken: R2, expiresIn: 3600 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INTUIT_TOKEN_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('qb-client-id:qb-client-secret-ZZZ').toString('base64')}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: 'authorization_code', code: 'the-code', redirect_uri: `${BASE}/api/intuit/callback`,
    });
    expect(init.redirect).toBe('error');
  });

  it('errors carry no code, token or body', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant', error_description: `bad code the-code ${R1}` }, 400));
    const err = await exchangeIntuitCode({
      client: { clientId: 'a', clientSecret: 'b' }, code: 'the-code', redirectUri: 'r', fetchImpl: fetchImpl as never,
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('the-code');
    expect((err as Error).message).not.toContain(R1);
  });
});

describe('token manager', () => {
  const make = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) =>
    createIntuitTokenManager({ store, fetchImpl: fetchImpl as never, now: () => now, log });

  it('refreshes with Basic auth, saves the NEW refresh token, caches the access token', async () => {
    const calls: RequestInit[] = [];
    const tm = make(async (_u, init) => (calls.push(init), json(tokenBody())));
    expect(await tm.getAccessToken(account)).toBe(ACCESS);
    expect(await store.tokens.getRefreshToken(account.id)).toBe(R2);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body as string))).toEqual({ grant_type: 'refresh_token', refresh_token: R1 });
    expect((calls[0]!.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    // The rotated token is encrypted at rest.
    expect(JSON.stringify(store._dump())).not.toContain(R2);
  });

  it('each refresh uses the token saved by the previous one', async () => {
    const used: string[] = [];
    let n = 0;
    const tm = make(async (_u, init) => {
      used.push(new URLSearchParams(init.body as string).get('refresh_token')!);
      return json(tokenBody({ refresh_token: [R2, R3][n++] }));
    });
    await tm.getAccessToken(account, { forceRefresh: true });
    await tm.getAccessToken(account, { forceRefresh: true });
    expect(used).toEqual([R1, R2]);
    expect(await store.tokens.getRefreshToken(account.id)).toBe(R3);
  });

  it('keeps the old refresh token when Intuit returns none', async () => {
    const tm = make(async () => json(tokenBody({ refresh_token: undefined })));
    await tm.getAccessToken(account);
    expect(await store.tokens.getRefreshToken(account.id)).toBe(R1);
  });

  it('caches the access token until one minute before expiry', async () => {
    const fetchImpl = vi.fn(async () => json(tokenBody({ expires_in: 3600 })));
    const tm = make(fetchImpl as never);
    await tm.getAccessToken(account);
    now += 3600_000 - 61_000;
    await tm.getAccessToken(account);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2_000; // inside the 60 s margin
    await tm.getAccessToken(account);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('concurrent refreshes in one process make one request and keep the rotated token', async () => {
    const fetchImpl = vi.fn(async () => json(tokenBody()));
    const tm = make(fetchImpl as never);
    const out = await Promise.all([1, 2, 3, 4].map(() => tm.getAccessToken(account, { forceRefresh: true })));
    expect(new Set(out)).toEqual(new Set([ACCESS]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await store.tokens.getRefreshToken(account.id)).toBe(R2);
  });

  it('two instances refreshing at once cannot overwrite each other: one rotated token survives', async () => {
    // Both read R1 before either saves. Each gets its own new token; the store keeps whichever swapped first.
    let n = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const mk = () =>
      make(async () => {
        const mine = n++ === 0 ? R2 : R3;
        await gate;
        return json(tokenBody({ refresh_token: mine, access_token: `access-for-${mine}` }));
      });
    const a = mk().getAccessToken(account, { forceRefresh: true });
    const b = mk().getAccessToken(account, { forceRefresh: true });
    await new Promise((r) => setTimeout(r, 10));
    open();
    await Promise.all([a, b]);
    const kept = await store.tokens.getRefreshToken(account.id);
    expect([R2, R3]).toContain(kept);
    expect(logs.some((l) => l.msg === 'refresh token rotation lost a race')).toBe(true);
  });

  it('invalid_grant marks the account needs_reconnect and throws a ProviderError without secrets', async () => {
    const tm = make(async () => json({ error: 'invalid_grant', error_description: `Token invalid ${R1}` }, 400));
    const err = await tm.getAccessToken(account).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('needs_reconnect');
    expect((await store.accounts.list())[0]!.status).toBe('needs_reconnect');
    const text = JSON.stringify(logs) + (err as Error).message + JSON.stringify(store._dump());
    expect(text).not.toContain(R1);
    expect(text).not.toContain('qb-client-secret-ZZZ');
  });

  it('invalid_grant after another instance rotated the token retries once with the new one', async () => {
    let call = 0;
    const tm = make(async (_u, init) => {
      call++;
      if (call === 1) {
        // Meanwhile another instance saved R3.
        await store.tokens.setRefreshToken(account.id, R3);
        return json({ error: 'invalid_grant' }, 400);
      }
      expect(new URLSearchParams(init.body as string).get('refresh_token')).toBe(R3);
      return json(tokenBody());
    });
    expect(await tm.getAccessToken(account, { forceRefresh: true })).toBe(ACCESS);
    expect((await store.accounts.list())[0]!.status).toBe('active');
  });

  it('a missing refresh token means needs_reconnect', async () => {
    const other = await store.accounts.upsertOnConnect({
      provider: 'intuit', email: 'x@intuit.local', label: 'other', orgClientId: org, grantedScopes: [], realmId: '999',
    });
    const err = await make(async () => json(tokenBody())).getAccessToken(other).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('needs_reconnect');
  });

  it('other failures are upstream errors and do not disconnect the account', async () => {
    const tm = make(async () => json({ error: 'server_error' }, 500));
    const err = await tm.getAccessToken(account).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('upstream_error');
    expect((await store.accounts.list())[0]!.status).toBe('active');
  });

  it('refuses a Google account', async () => {
    const g = { ...account, provider: 'google' as const };
    const fetchImpl = vi.fn();
    const err = await make(fetchImpl as never).getAccessToken(g).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('upstream_error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs contain no token or secret', async () => {
    await make(async () => json(tokenBody())).getAccessToken(account);
    await make(async () => json({ error: 'invalid_grant' }, 400)).getAccessToken(account, { forceRefresh: true }).catch(() => undefined);
    const text = JSON.stringify(logs);
    for (const secret of [R1, R2, ACCESS, 'qb-client-secret-ZZZ']) expect(text).not.toContain(secret);
  });
});
