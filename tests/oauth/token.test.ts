import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAuthorizeGet, handleAuthorizePost } from '@/oauth/authorize';
import { verifyBearerWithContext } from '@/oauth/bearer';
import { handleToken } from '@/oauth/token';
import { hashToken } from '@/lib/crypto';
import { ADMIN, BASE, form, get, makeCtx, obtainCode, pkce, REDIRECT, register, sessionCookie } from './helpers';

afterEach(() => vi.useRealTimers());

const H = { get: handleAuthorizeGet, post: handleAuthorizePost };

async function setup(over: Record<string, string | undefined> = {}) {
  const m = await makeCtx(over);
  const client = await register(m.ctx);
  const cookie = await sessionCookie();
  const p = pkce();
  const code = await obtainCode(m.ctx, client.clientId, p.challenge, cookie, H);
  const exchange = (o: Record<string, string> = {}) =>
    handleToken(m.ctx, form('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.clientId, code_verifier: p.verifier, ...o }));
  const refresh = (rt: string, clientId = client.clientId) =>
    handleToken(m.ctx, form('/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: clientId }));
  const bearer = (t: string) => verifyBearerWithContext(m.ctx, new Request(`${BASE}/api/mcp`, { headers: { authorization: `Bearer ${t}` } }));
  return { ...m, client, cookie, p, code, exchange, refresh, bearer };
}

describe('authorization_code grant', () => {
  it('happy path: issues tokens, no-store headers, and bearer verifies', async () => {
    const s = await setup();
    const res = await s.exchange();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const t = await res.json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(await s.bearer(t.access_token)).toEqual({ subject: ADMIN, clientId: s.client.clientId });
    // only hashes are stored
    const dump = JSON.stringify((s.store as unknown as { _dump(): unknown })._dump());
    expect(dump).not.toContain(t.access_token);
    expect(dump).not.toContain(t.refresh_token);
    expect(dump).not.toContain(s.code);
    // refresh token is not usable as an access token and vice versa
    expect(await s.bearer(t.refresh_token)).toBeNull();
    expect((await s.refresh(t.access_token)).status).toBe(400);
  });

  it('rejects a wrong verifier, and the code is burned', async () => {
    const s = await setup();
    const bad = await s.exchange({ code_verifier: 'x'.repeat(50) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_grant');
    expect((await s.exchange()).status).toBe(400);
  });

  it('rejects code reuse', async () => {
    const s = await setup();
    expect((await s.exchange()).status).toBe(200);
    const again = await s.exchange();
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('invalid_grant');
  });

  it('rejects a code bound to another client or redirect_uri', async () => {
    const s = await setup();
    const other = await register(s.ctx);
    const r1 = await s.exchange({ client_id: other.clientId });
    expect((await r1.json()).error).toBe('invalid_grant');
    // the mismatch attempt burned the code
    expect((await s.exchange()).status).toBe(400);

    const s2 = await setup();
    const r2 = await s2.exchange({ redirect_uri: 'https://claude.ai/different' });
    expect((await r2.json()).error).toBe('invalid_grant');
  });

  it('rejects an expired code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await setup();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
    const res = await s.exchange();
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('rejects when the subject has left ADMIN_EMAILS before exchange', async () => {
    const s = await setup();
    // same store, narrower allowlist
    const { ctx: narrow } = await makeCtx({ ADMIN_EMAILS: 'someone.else@example.test' });
    const ctx2 = { ...narrow, store: s.store };
    const res = await handleToken(ctx2, form('/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: REDIRECT, client_id: s.client.clientId, code_verifier: s.p.verifier }));
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns RFC 6749 errors for malformed requests', async () => {
    const s = await setup();
    const err = async (r: Response) => (await r.json()).error;
    expect(await err(await handleToken(s.ctx, form('/token', { grant_type: 'password', client_id: s.client.clientId })))).toBe('unsupported_grant_type');
    expect(await err(await handleToken(s.ctx, form('/token', { grant_type: 'authorization_code' })))).toBe('invalid_request');
    expect(await err(await handleToken(s.ctx, form('/token', { grant_type: 'authorization_code', client_id: 'nope' })))).toBe('invalid_client');
    expect(await err(await handleToken(s.ctx, form('/token', { grant_type: 'authorization_code', client_id: s.client.clientId })))).toBe('invalid_request');
    const dup = new Request(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&grant_type=authorization_code' });
    expect(await err(await handleToken(s.ctx, dup))).toBe('invalid_request');
    const json = new Request(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await err(await handleToken(s.ctx, json))).toBe('invalid_request');
  });
});

describe('refresh_token grant', () => {
  it('rotates: the old refresh token fails and the new pair works', async () => {
    const s = await setup();
    const t1 = await (await s.exchange()).json();
    const r = await s.refresh(t1.refresh_token);
    expect(r.status).toBe(200);
    const t2 = await r.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(await s.bearer(t2.access_token)).not.toBeNull();
    const old = await s.refresh(t1.refresh_token);
    expect((await old.json()).error).toBe('invalid_grant');
  });

  it('reuse of a rotated token revokes the whole family', async () => {
    const s = await setup();
    const t1 = await (await s.exchange()).json();
    const t2 = await (await s.refresh(t1.refresh_token)).json();
    expect(await s.bearer(t2.access_token)).not.toBeNull();
    expect((await s.refresh(t1.refresh_token)).status).toBe(400); // replay
    expect(await s.bearer(t2.access_token)).toBeNull();
    expect((await s.refresh(t2.refresh_token)).status).toBe(400);
  });

  it('two concurrent refreshes with the same token: at most one succeeds', async () => {
    const s = await setup();
    const t1 = await (await s.exchange()).json();
    const results = await Promise.all([s.refresh(t1.refresh_token), s.refresh(t1.refresh_token), s.refresh(t1.refresh_token)]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('rejects a different client, an expired token and a removed admin', async () => {
    const s = await setup();
    const other = await register(s.ctx);
    const t1 = await (await s.exchange()).json();
    expect((await (await s.refresh(t1.refresh_token, other.clientId)).json()).error).toBe('invalid_grant');
    // client mismatch revoked the family
    expect((await s.refresh(t1.refresh_token)).status).toBe(400);

    vi.useFakeTimers({ toFake: ['Date'] });
    const s2 = await setup();
    const t = await (await s2.exchange()).json();
    vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
    expect((await s2.refresh(t.refresh_token)).status).toBe(400);
  });

  it('a refresh issued for a removed admin is refused', async () => {
    const s = await setup();
    const t1 = await (await s.exchange()).json();
    const { ctx: narrow } = await makeCtx({ ADMIN_EMAILS: 'someone.else@example.test' });
    const res = await handleToken({ ...narrow, store: s.store }, form('/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: s.client.clientId }));
    expect(res.status).toBe(400);
  });
});

describe('verifyBearer', () => {
  it('rejects missing, malformed, unknown, expired and de-allowlisted tokens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await setup();
    const t = await (await s.exchange()).json();
    const req = (h?: string) => new Request(`${BASE}/api/mcp`, { headers: h ? { authorization: h } : {} });
    expect(await verifyBearerWithContext(s.ctx, req())).toBeNull();
    expect(await verifyBearerWithContext(s.ctx, req('Basic abc'))).toBeNull();
    expect(await verifyBearerWithContext(s.ctx, req('Bearer'))).toBeNull();
    expect(await verifyBearerWithContext(s.ctx, req('Bearer unknown'))).toBeNull();
    expect(await verifyBearerWithContext(s.ctx, req(`bEaReR ${t.access_token}`))).not.toBeNull();

    const { ctx: narrow } = await makeCtx({ ADMIN_EMAILS: 'someone.else@example.test' });
    expect(await verifyBearerWithContext({ ...narrow, store: s.store }, req(`Bearer ${t.access_token}`))).toBeNull();

    vi.setSystemTime(Date.now() + 3600 * 1000 + 1000);
    expect(await verifyBearerWithContext(s.ctx, req(`Bearer ${t.access_token}`))).toBeNull();
  });

  it('rejects a revoked access token', async () => {
    const s = await setup();
    const t = await (await s.exchange()).json();
    expect(await s.store.oauth.revokeToken(hashToken(t.access_token))).toBe(true);
    expect(await s.bearer(t.access_token)).toBeNull();
  });
});

describe('no leaks', () => {
  it('logs and non-token responses never contain raw codes or tokens', async () => {
    const s = await setup();
    const secrets = new Set<string>([s.code]);
    const bodies: string[] = [];
    const t1 = await (await s.exchange()).json();
    secrets.add(t1.access_token).add(t1.refresh_token);
    bodies.push(await (await s.exchange()).text()); // reuse
    const r = await s.refresh(t1.refresh_token);
    const t2 = await r.json();
    secrets.add(t2.access_token).add(t2.refresh_token);
    bodies.push(await (await s.refresh(t1.refresh_token)).text()); // replay
    bodies.push(await (await s.refresh('bogus')).text());
    bodies.push(await (await handleToken(s.ctx, form('/token', { grant_type: 'password', client_id: s.client.clientId }))).text());
    const page = await handleAuthorizeGet(s.ctx, get(`/authorize?client_id=${s.client.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`, s.cookie));
    bodies.push(await page.text());
    const hay = JSON.stringify(s.logs) + bodies.join('\n');
    for (const secret of secrets) expect(hay).not.toContain(secret);
    expect(s.logs.length).toBeGreaterThan(0);
  });
});
