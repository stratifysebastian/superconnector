import { describe, expect, it } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from '@/oauth/metadata';
import { handleRegister } from '@/oauth/register';
import { BASE, makeCtx } from './helpers';

describe('metadata', () => {
  it('RFC 8414 authorization server document', async () => {
    const { ctx } = await makeCtx();
    expect(await authorizationServerMetadata(ctx).json()).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  it('RFC 9728 protected resource document', async () => {
    const { ctx } = await makeCtx();
    expect(await protectedResourceMetadata(ctx).json()).toEqual({
      resource: `${BASE}/api/mcp`,
      authorization_servers: [BASE],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  });
});

const post = (body: unknown) =>
  new Request(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const { ctx, store } = await makeCtx();
    const res = await handleRegister(ctx, post({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect((await store.oauth.getClient(body.client_id))?.redirectUris).toEqual(body.redirect_uris);
  });

  it('accepts claude.com and loopback with a port', async () => {
    const { ctx } = await makeCtx();
    const res = await handleRegister(ctx, post({ redirect_uris: ['https://claude.com/cb', 'http://localhost:6274/cb', 'http://127.0.0.1:33/x'] }));
    expect(res.status).toBe(201);
  });

  it('rejects redirect origins that are not allowed', async () => {
    const { ctx } = await makeCtx();
    for (const uri of [
      'https://evil.example/cb',
      'http://claude.ai/cb',
      'https://claude.ai.evil.test/cb',
      'http://localhost/cb',
      'http://localhost.evil.test:80/cb',
      'https://claude.ai/cb#frag',
      'https://user:pw@claude.ai/cb',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const res = await handleRegister(ctx, post({ redirect_uris: [uri] }));
      expect(res.status, uri).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects missing, empty or too many redirect_uris', async () => {
    const { ctx } = await makeCtx();
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: Array(6).fill('https://claude.ai/cb') }, { redirect_uris: 'https://claude.ai/cb' }]) {
      const res = await handleRegister(ctx, post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects confidential clients, bad JSON and oversized bodies', async () => {
    const { ctx } = await makeCtx();
    const conf = await handleRegister(ctx, post({ redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'client_secret_basic' }));
    expect((await conf.json()).error).toBe('invalid_client_metadata');
    expect((await handleRegister(ctx, post('{not json'))).status).toBe(400);
    const big = await handleRegister(ctx, post({ redirect_uris: ['https://claude.ai/cb'], client_name: 'x'.repeat(11_000) }));
    expect(big.status).toBe(413);
  });
});
