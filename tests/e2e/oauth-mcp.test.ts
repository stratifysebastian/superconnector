// End-to-end (in process, mock mode): discovery -> DCR -> PKCE authorize -> token -> MCP client -> refresh.
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, SESSION_COOKIE } from '@/auth/session-token';
import { createCipher } from '@/lib/crypto';
import { parseEnv, type Env } from '@/lib/env';
import { handleMcpRequest } from '@/mcp/handler';
import { handleAuthorizeGet, handleAuthorizePost } from '@/oauth/authorize';
import { authorizationServerMetadata, protectedResourceMetadata } from '@/oauth/metadata';
import { handleRegister } from '@/oauth/register';
import { handleToken } from '@/oauth/token';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';
import { assertNoExcludedTools } from '../contract/excluded';

// handleMcpRequest's default verifier (verifyBearer) reads the process-wide getServerContext() singleton
// rather than deps.ctx (see the it.fails test at the bottom). To keep real bearer verification without
// injecting `verify`, point that singleton at the context under test.
const singleton = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/server/context', async (orig) => ({
  ...(await orig<typeof import('@/server/context')>()),
  getServerContext: async () => singleton.current,
}));

const BASE = 'https://mcp.e2e.example.test';
const ADMIN = 'admin@e2e.example.test';
const SECRET = 'e2e-session-secret-0123456789abcdef0123';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const WELL_KNOWN_PRM = `${BASE}/.well-known/oauth-protected-resource`;

function mockEnv(adminEmails: string): Env {
  return parseEnv({
    GOOGLE_MODE: 'mock',
    STORE: 'memory',
    SESSION_SECRET: SECRET,
    ADMIN_EMAILS: adminEmails,
    PUBLIC_BASE_URL: BASE,
  });
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function makeCtx(adminEmails = ADMIN): Promise<ServerContext> {
  const env = mockEnv(adminEmails);
  const store = createMemoryStore(createCipher(Buffer.alloc(32, 5).toString('base64')));
  const ctx = await createServerContext({ env, store, log: quiet });
  singleton.current = ctx;
  return ctx;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

interface Session {
  clientId: string;
  tokens: Tokens;
}

function tokenPost(ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return handleToken(
    ctx,
    new Request(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }),
  );
}

/** Runs steps 1-6 as Claude would, against the given context. */
async function runOAuthFlow(ctx: ServerContext): Promise<Session> {
  // 1. Discovery: only the protected-resource well-known URL is known up front.
  const prm = (await protectedResourceMetadata(ctx).json()) as { resource: string; authorization_servers: string[] };
  expect(prm.authorization_servers).toHaveLength(1);
  const asm = (await authorizationServerMetadata(ctx).json()) as Record<string, string | string[]>;
  expect(asm.issuer).toBe(prm.authorization_servers[0]);
  expect(asm.code_challenge_methods_supported).toContain('S256');
  const authorizeUrl = asm.authorization_endpoint as string;
  const tokenUrl = asm.token_endpoint as string;
  const registerUrl = asm.registration_endpoint as string;

  // 2. Dynamic client registration.
  const reg = await handleRegister(
    ctx,
    new Request(registerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: 'Claude',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;

  // 3. PKCE.
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(12).toString('base64url');

  // 4. Authorize with the admin session cookie; parse the consent page.
  const cookie = `${SESSION_COOKIE}=${await createSessionToken(ADMIN, { secret: SECRET })}`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'mcp',
    resource: prm.resource,
  });
  const page = await handleAuthorizeGet(ctx, new Request(`${authorizeUrl}?${q}`, { headers: { cookie } }));
  expect(page.status).toBe(200);
  const html = await page.text();
  const fields = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields.set(m[1] as string, (m[2] as string).replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }
  expect(fields.get('csrf')).toBeTruthy();
  expect(fields.get('client_id')).toBe(clientId);
  expect(fields.get('redirect_uri')).toBe(REDIRECT);
  expect(fields.get('state')).toBe(state);
  fields.set('decision', 'approve');

  // 5. Approve, with the same cookie and a same-origin Origin header.
  const approve = await handleAuthorizePost(
    ctx,
    new Request(authorizeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: new URL(BASE).origin },
      body: fields.toString(),
    }),
  );
  expect(approve.status).toBe(302);
  const loc = new URL(approve.headers.get('location') as string);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe(state);
  const code = loc.searchParams.get('code');
  expect(code).toBeTruthy();

  // 6. Code exchange.
  expect(tokenUrl).toBe(`${BASE}/token`);
  const tok = await tokenPost(ctx, {
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(tok.status).toBe(200);
  const tokens = (await tok.json()) as Tokens;
  expect(tokens.token_type).toBe('Bearer');
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return { clientId, tokens };
}

/** Real bearer verification: no `verify` injected. */
async function connect(ctx: ServerContext, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init), { ctx }),
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'claude-e2e', version: '0' });
  await client.connect(transport);
  return client;
}

async function listAccounts(client: Client) {
  const res = await client.callTool({ name: 'list_accounts', arguments: {} });
  return (res.structuredContent as { accounts: Array<Record<string, unknown>> }).accounts;
}

const rawMcp = (ctx: ServerContext, headers: Record<string, string> = {}) =>
  handleMcpRequest(
    new Request(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    { ctx },
  );

describe('OAuth 2.1 + MCP end to end (mock mode)', () => {
  let ctx: ServerContext;
  let s: Session;

  beforeEach(async () => {
    ctx = await makeCtx();
    s = await runOAuthFlow(ctx);
  });

  it('discovers, registers, authorizes, gets tokens, and lists both accounts as active', async () => {
    expect(new URL(WELL_KNOWN_PRM).pathname).toBe('/.well-known/oauth-protected-resource');
    const client = await connect(ctx, s.tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_accounts');
    expect(() => assertNoExcludedTools(names)).not.toThrow();

    const accounts = await listAccounts(client);
    expect(accounts.map((a) => [a.label, a.priority, a.status])).toEqual([
      ['stratify', 1, 'active'],
      ['prime', 2, 'active'],
    ]);
  });

  it('refresh rotates the pair; reusing the old refresh token revokes the family', async () => {
    const r = await tokenPost(ctx, { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token, client_id: s.clientId });
    expect(r.status).toBe(200);
    const next = (await r.json()) as Tokens;
    expect(next.access_token).not.toBe(s.tokens.access_token);
    expect(next.refresh_token).not.toBe(s.tokens.refresh_token);
    expect((await rawMcp(ctx, { Authorization: `Bearer ${next.access_token}` })).status).toBe(200);

    const reuse = await tokenPost(ctx, { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token, client_id: s.clientId });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');

    expect((await rawMcp(ctx, { Authorization: `Bearer ${next.access_token}` })).status).toBe(401);
  });

  it('rejects an MCP call without a token, pointing at the resource metadata', async () => {
    const res = await rawMcp(ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${WELL_KNOWN_PRM}"`);
  });

  it('rejects a tampered access token', async () => {
    const t = s.tokens.access_token;
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    expect((await rawMcp(ctx, { Authorization: `Bearer ${tampered}` })).status).toBe(401);
  });

  it('rejects the token once the admin email is removed from ADMIN_EMAILS', async () => {
    expect((await rawMcp(ctx, { Authorization: `Bearer ${s.tokens.access_token}` })).status).toBe(200);
    // Same token store, new env without the admin.
    const reduced = await createServerContext({
      env: mockEnv('someone-else@e2e.example.test'),
      store: ctx.store,
      log: quiet,
      seedMock: false,
    });
    singleton.current = reduced;
    expect((await rawMcp(reduced, { Authorization: `Bearer ${s.tokens.access_token}` })).status).toBe(401);
  });

  it('shows a needs_reconnect account with a reconnectUrl', async () => {
    const prime = (await ctx.store.accounts.list()).find((a) => a.label === 'prime');
    expect(prime).toBeDefined();
    await ctx.store.accounts.setStatus(prime!.id, 'needs_reconnect');
    const accounts = await listAccounts(await connect(ctx, s.tokens.access_token));
    expect(accounts[0]).toMatchObject({ label: 'stratify', status: 'active' });
    expect(accounts[1]).toMatchObject({ label: 'prime', status: 'needs_reconnect', reconnectUrl: `${BASE}/connect` });
  });

  // TODO(bug): handleMcpRequest(req, { ctx }) verifies the bearer via verifyBearer(), which calls the global
  // getServerContext() instead of deps.ctx. With an explicit ctx whose store holds the token, but a different
  // process singleton, a valid token is rejected. Fix: default verify to verifyBearerWithContext(ctx, req).
  it.fails('verifies the bearer against deps.ctx, not the process singleton', async () => {
    singleton.current = await makeCtx('other-admin@e2e.example.test'); // unrelated singleton
    const res = await rawMcp(ctx, { Authorization: `Bearer ${s.tokens.access_token}` });
    expect(res.status).toBe(200);
  });
});
