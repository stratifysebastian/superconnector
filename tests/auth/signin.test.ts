import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { sanitizeNext } from '@/auth/redirect';
import { handleSigninCallback, handleSigninStart, handleSignout } from '@/auth/signin';
import { getAdminSessionFromRequest } from '@/auth/session';
import { ADMIN, BASE, get, googleKeys, makeCtx, signIdToken } from '../oauth/helpers';

async function start(ctx: Awaited<ReturnType<typeof makeCtx>>['ctx'], next?: string) {
  const res = await handleSigninStart(ctx, get(`/api/auth/start${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`));
  const loc = new URL(res.headers.get('location') as string);
  const cookie = (res.headers.getSetCookie()[0] as string).split(';')[0] as string;
  return { res, loc, cookie, state: loc.searchParams.get('state') as string, nonce: loc.searchParams.get('nonce') as string };
}

async function callback(
  ctx: Awaited<ReturnType<typeof makeCtx>>['ctx'],
  s: Awaited<ReturnType<typeof start>>,
  idToken: string,
  jwks: Awaited<ReturnType<typeof googleKeys>>['jwks'],
  stateOverride?: string,
) {
  const fetchFn = async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
  return handleSigninCallback(
    ctx,
    get(`/api/auth/callback?code=fake-google-code&state=${stateOverride ?? s.state}`, s.cookie),
    { jwks, fetchFn },
  );
}

describe('sign-in start', () => {
  it('redirects to Google with PKCE S256, nonce, select_account and a hardened cookie', async () => {
    const { ctx } = await makeCtx();
    const s = await start(ctx, '/authorize?x=1');
    expect(s.loc.origin + s.loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(s.loc.searchParams.get('scope')).toBe('openid email');
    expect(s.loc.searchParams.get('prompt')).toBe('select_account');
    expect(s.loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(s.loc.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback`);
    const raw = s.res.headers.getSetCookie()[0] as string;
    expect(raw).toMatch(/^sc_oidc=/);
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/auth', 'Max-Age=600']) expect(raw).toContain(a);
    // the verifier never leaves the server in the clear
    expect(s.loc.toString()).not.toContain('code_verifier');
  });

  it('returns 503 when admin sign-in is not configured (mock mode)', async () => {
    const { ctx } = await makeCtx({
      GOOGLE_MODE: 'mock',
      SESSION_SECRET: undefined,
      ADMIN_GOOGLE_CLIENT_ID: undefined,
      ADMIN_GOOGLE_CLIENT_SECRET: undefined,
    });
    const res = await handleSigninStart(ctx, get('/api/auth/start'));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Admin sign-in is not configured');
  });
});

describe('sign-in callback', () => {
  it('signs in an allowlisted, verified email and sets a 12h session cookie', async () => {
    const { ctx, env } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx, '/authorize?client_id=abc');
    const idToken = await signIdToken(privateKey, { email: 'Seb@Example.test', email_verified: true, nonce: s.nonce });
    const res = await callback(ctx, s, idToken, jwks);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/authorize?client_id=abc`);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('sc_session='))!;
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) expect(session).toContain(a);
    expect(cookies.find((c) => c.startsWith('sc_oidc='))).toContain('Max-Age=0');
    const me = await getAdminSessionFromRequest(get('/', session.split(';')[0]), env);
    expect(me?.email).toBe(ADMIN);
  });

  it('refuses a non-allowlisted email with 403 and no session', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx);
    const idToken = await signIdToken(privateKey, { email: 'mallory@example.test', email_verified: true, nonce: s.nonce });
    const res = await callback(ctx, s, idToken, jwks);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('This Google account is not allowed');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sc_session=') && !c.includes('Max-Age=0'))).toBe(false);
  });

  it('refuses an unverified email', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx);
    const idToken = await signIdToken(privateKey, { email: ADMIN, email_verified: false, nonce: s.nonce });
    expect((await callback(ctx, s, idToken, jwks)).status).toBe(403);
  });

  it('refuses a bad nonce', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx);
    const idToken = await signIdToken(privateKey, { email: ADMIN, email_verified: true, nonce: 'wrong' });
    const res = await callback(ctx, s, idToken, jwks);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sc_session=') && !c.includes('Max-Age=0'))).toBe(false);
  });

  it('refuses a token signed by the wrong key', async () => {
    const { ctx } = await makeCtx();
    const { jwks } = await googleKeys();
    const attacker = await generateKeyPair('RS256');
    const s = await start(ctx);
    const idToken = await signIdToken(attacker.privateKey, { email: ADMIN, email_verified: true, nonce: s.nonce });
    expect((await callback(ctx, s, idToken, jwks)).status).toBe(403);
  });

  it('refuses wrong audience, wrong issuer and expired tokens', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx);
    const claims = { email: ADMIN, email_verified: true, nonce: s.nonce };
    expect((await callback(ctx, s, await signIdToken(privateKey, claims, { aud: 'other' }), jwks)).status).toBe(403);
    expect((await callback(ctx, s, await signIdToken(privateKey, claims, { iss: 'https://evil.test' }), jwks)).status).toBe(403);
    expect((await callback(ctx, s, await signIdToken(privateKey, claims, { expSeconds: -120 }), jwks)).status).toBe(403);
  });

  it('refuses a state mismatch, a missing cookie and a tampered cookie', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    const s = await start(ctx);
    const idToken = await signIdToken(privateKey, { email: ADMIN, email_verified: true, nonce: s.nonce });
    expect((await callback(ctx, s, idToken, jwks, 'not-the-state')).status).toBe(400);
    const fetchFn = async () => new Response(JSON.stringify({ id_token: idToken }));
    const noCookie = await handleSigninCallback(ctx, get(`/api/auth/callback?code=c&state=${s.state}`), { jwks, fetchFn });
    expect(noCookie.status).toBe(400);
    const tampered = `${s.cookie.slice(0, -3)}AAA`;
    const res = await handleSigninCallback(ctx, get(`/api/auth/callback?code=c&state=${s.state}`, tampered), { jwks, fetchFn });
    expect(res.status).toBe(400);
  });

  it('falls back to /connect for an open-redirect next', async () => {
    const { ctx } = await makeCtx();
    const { privateKey, jwks } = await googleKeys();
    for (const evil of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const s = await start(ctx, evil);
      const idToken = await signIdToken(privateKey, { email: ADMIN, email_verified: true, nonce: s.nonce });
      const res = await callback(ctx, s, idToken, jwks);
      expect(res.headers.get('location')).toBe(`${BASE}/connect`);
    }
  });
});

describe('sanitizeNext', () => {
  it('only allows same-origin relative paths', () => {
    expect(sanitizeNext('/authorize?a=b')).toBe('/authorize?a=b');
    for (const bad of [null, undefined, '', 'connect', '//evil.com', 'https://evil.com', '/\\evil.com', '/a\nb', 'javascript:alert(1)']) {
      expect(sanitizeNext(bad)).toBe('/connect');
    }
  });
});

describe('sign-out', () => {
  it('clears the cookie and redirects to /signin; refuses cross-origin', async () => {
    const { ctx } = await makeCtx();
    const ok = await handleSignout(ctx, new Request(`${BASE}/api/auth/signout`, { method: 'POST' }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`${BASE}/signin`);
    expect(ok.headers.getSetCookie()[0]).toContain('Max-Age=0');
    const bad = await handleSignout(ctx, new Request(`${BASE}/api/auth/signout`, { method: 'POST', headers: { origin: 'https://evil.test' } }));
    expect(bad.status).toBe(403);
  });
});
