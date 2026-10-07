import { describe, expect, it } from 'vitest';
import { handleAuthorizeGet, handleAuthorizePost } from '@/oauth/authorize';
import { hashToken } from '@/lib/crypto';
import { ADMIN, authorizeQuery, BASE, form, get, hiddenFields, makeCtx, pkce, REDIRECT, register, sessionCookie } from './helpers';

async function setup() {
  const m = await makeCtx();
  const client = await register(m.ctx);
  const cookie = await sessionCookie();
  return { ...m, client, cookie, ...pkce() };
}

describe('GET /authorize validation', () => {
  it('shows an error page and never redirects for an unknown client', async () => {
    const { ctx, challenge, cookie } = await setup();
    const res = await handleAuthorizeGet(ctx, get(`/authorize?${authorizeQuery('nope', challenge)}`, cookie));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('shows an error page and never redirects for a mismatched redirect_uri', async () => {
    const { ctx, client, challenge, cookie } = await setup();
    for (const uri of ['https://claude.ai/other', `${REDIRECT}/`, 'https://evil.example/cb']) {
      const q = authorizeQuery(client.clientId, challenge, { redirect_uri: uri });
      const res = await handleAuthorizeGet(ctx, get(`/authorize?${q}`, cookie));
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('redirects invalid_request for plain, S256-less or missing challenge', async () => {
    const { ctx, client, challenge, cookie } = await setup();
    const cases = [
      authorizeQuery(client.clientId, challenge, { code_challenge_method: 'plain' }),
      authorizeQuery(client.clientId, challenge, { code_challenge_method: undefined }),
      authorizeQuery(client.clientId, challenge, { code_challenge: undefined }),
      authorizeQuery(client.clientId, 'short'),
    ];
    for (const q of cases) {
      const res = await handleAuthorizeGet(ctx, get(`/authorize?${q}`, cookie));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('st-123');
    }
  });

  it('rejects a foreign resource and a bad response_type', async () => {
    const { ctx, client, challenge, cookie } = await setup();
    const r1 = await handleAuthorizeGet(ctx, get(`/authorize?${authorizeQuery(client.clientId, challenge, { resource: 'https://other.example/mcp' })}`, cookie));
    expect(new URL(r1.headers.get('location') as string).searchParams.get('error')).toBe('invalid_target');
    const r2 = await handleAuthorizeGet(ctx, get(`/authorize?${authorizeQuery(client.clientId, challenge, { response_type: 'token' })}`, cookie));
    expect(new URL(r2.headers.get('location') as string).searchParams.get('error')).toBe('unsupported_response_type');
    const ok = await handleAuthorizeGet(ctx, get(`/authorize?${authorizeQuery(client.clientId, challenge, { resource: `${BASE}/api/mcp` })}`, cookie));
    expect(ok.status).toBe(200);
  });
});

describe('GET /authorize session and consent', () => {
  it('redirects to sign-in with a same-origin next when there is no session', async () => {
    const { ctx, client, challenge } = await setup();
    const url = `/authorize?${authorizeQuery(client.clientId, challenge)}`;
    const res = await handleAuthorizeGet(ctx, get(url));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.origin + loc.pathname).toBe(`${BASE}/signin`);
    expect(loc.searchParams.get('next')).toBe(url);
  });

  it('renders a consent page naming client, redirect host and email, with framing protections', async () => {
    const { ctx, client, challenge, cookie } = await setup();
    const res = await handleAuthorizeGet(ctx, get(`/authorize?${authorizeQuery(client.clientId, challenge)}`, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain(client.clientId);
    expect(html).toContain('claude.ai');
    expect(html).toContain(ADMIN);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
    expect(hiddenFields(html).get('csrf')).toBeTruthy();
  });

  it('escapes hostile parameter values in the page', async () => {
    const { ctx, client, challenge, cookie } = await setup();
    const q = authorizeQuery(client.clientId, challenge, { state: '"><script>alert(1)</script>' });
    const html = await (await handleAuthorizeGet(ctx, get(`/authorize?${q}`, cookie))).text();
    expect(html).not.toContain('<script>');
  });
});

describe('POST /authorize', () => {
  async function consent(s: Awaited<ReturnType<typeof setup>>) {
    const page = await handleAuthorizeGet(s.ctx, get(`/authorize?${authorizeQuery(s.client.clientId, s.challenge)}`, s.cookie));
    return hiddenFields(await page.text());
  }

  it('approve issues a single-use code bound to client, redirect, challenge and subject', async () => {
    const s = await setup();
    const f = await consent(s);
    f.set('decision', 'approve');
    const res = await handleAuthorizePost(s.ctx, form('/authorize', f, s.cookie));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st-123');
    const code = loc.searchParams.get('code') as string;
    expect(code.length).toBeGreaterThanOrEqual(43);
    const row = await s.store.oauth.consumeCode(hashToken(code));
    expect(row).toMatchObject({ clientId: s.client.clientId, redirectUri: REDIRECT, codeChallenge: s.challenge, subject: ADMIN });
    expect(row!.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });

  it('deny redirects with access_denied and issues no code', async () => {
    const s = await setup();
    const f = await consent(s);
    f.set('decision', 'deny');
    const res = await handleAuthorizePost(s.ctx, form('/authorize', f, s.cookie));
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
    expect(loc.searchParams.get('state')).toBe('st-123');
  });

  it('rejects a bad, missing, foreign-subject or parameter-swapped CSRF token', async () => {
    const s = await setup();
    const f = await consent(s);
    f.set('decision', 'approve');
    const attempts: URLSearchParams[] = [];
    const bad = new URLSearchParams(f); bad.set('csrf', 'garbage'); attempts.push(bad);
    const missing = new URLSearchParams(f); missing.delete('csrf'); attempts.push(missing);
    const swapped = new URLSearchParams(f); swapped.set('state', 'other-state'); attempts.push(swapped);
    for (const a of attempts) {
      const res = await handleAuthorizePost(s.ctx, form('/authorize', a, s.cookie));
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    // token minted for another admin's session does not work for this one
    const other = await sessionCookie('other@example.test');
    const res = await handleAuthorizePost(s.ctx, form('/authorize', f, other));
    expect(res.status).toBe(403);
  });

  it('rejects when there is no session or the origin is foreign', async () => {
    const s = await setup();
    const f = await consent(s);
    f.set('decision', 'approve');
    expect((await handleAuthorizePost(s.ctx, form('/authorize', f))).status).toBe(401);
    const res = await handleAuthorizePost(s.ctx, form('/authorize', f, s.cookie, { origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
  });
});
