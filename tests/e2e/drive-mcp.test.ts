// End-to-end Drive tools through the real server stack in mock mode (OAuth bearer -> MCP client -> registry).
// The OAuth helpers are copied from oauth-mcp.test.ts (they are not exported there).
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockDrive } from '@/google/mock/drive';
import { resetMockFaults, setMockFaults } from '@/google/mock/faults';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';
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

const BASE = 'https://mcp.e2e.example.test';
const ADMIN = 'admin@e2e.example.test';
const SECRET = 'e2e-session-secret-0123456789abcdef0123';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

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
  return createServerContext({ env, store, log: quiet });
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


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
interface Res { isError?: boolean; text: string; sc: R; content: R[] }

let ctx: ServerContext;
let client: Client;
let texts: string[] = [];

async function call(name: string, args: R = {}): Promise<Res> {
  const r = (await client.callTool({ name, arguments: args })) as R;
  const content = r.content as R[];
  const text = content.map((c) => c.text ?? '').join('\n');
  texts.push(text);
  return { isError: r.isError === true, text, sc: (r.structuredContent ?? {}) as R, content };
}

beforeEach(async () => {
  resetMockDrive();
  resetMockFaults();
  texts = [];
  ctx = await makeCtx();
  const s = await runOAuthFlow(ctx);
  client = await connect(ctx, s.tokens.access_token);
});

// No tool result in any test leaks credentials.
afterEach(() => {
  resetMockFaults();
  for (const t of texts) expect(t).not.toMatch(/access_token|refresh_token|Bearer/);
});

const HAND_BACK = /do not use another connector/;
const ms = (s: string | undefined) => (s ? Date.parse(s) : 0);
const nonIncreasing = (xs: number[]) => expect(xs).toEqual([...xs].sort((a, b) => b - a));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pageAll(tool: string, args: R, pageSize: number): Promise<R[]> {
  const seen: R[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    const r = await call(tool, { ...args, pageSize, ...(cursor ? { pageToken: cursor } : {}) });
    expect(r.isError).toBe(false);
    seen.push(...(r.sc.files as R[]));
    cursor = r.sc.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error('paging did not terminate');
}
const allIds = async () => (await pageAll('search_files', {}, 100)).map((f) => f.id as string);

describe('Drive MCP end to end (mock mode)', () => {
  it('1. lists exactly the enabled tools and none of the excluded ones', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(names).toHaveLength(60);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
    for (const n of ['share_file', 'trash_file', 'delete_file', 'untrash_file', 'empty_trash']) expect(names).not.toContain(n);
  });

  it('2. search_files with no query fans out, newest first, shared file once', async () => {
    const files = await pageAll('search_files', {}, 100);
    expect(new Set(files.map((f) => f.account))).toEqual(new Set(['stratify', 'prime']));
    nonIncreasing(files.map((f) => ms(f.modifiedTime)));
    const shared = files.filter((f) => f.id === 'shared-roadmap-doc');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.accounts).toEqual(['stratify', 'prime']);
    expect(shared[0]!.sources).toHaveLength(2);
    expect((await call('search_files', {})).sc.accountErrors).toEqual([]);
  });

  it('3. paging at pageSize 5 is complete, duplicate-free and ordered', async () => {
    const full = await allIds();
    const seen = await pageAll('search_files', {}, 5);
    const ids = seen.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(full));
    // Distinct ids across both accounts, counted from the fixtures through per-account searches.
    const per = new Set<string>();
    for (const account of ['stratify', 'prime']) for (const f of await pageAll('search_files', { account }, 100)) per.add(f.id);
    expect(new Set(ids)).toEqual(per);
    nonIncreasing(seen.map((f) => ms(f.modifiedTime)));
  });

  it('4. fullText lists account by account; paging at pageSize 2 is complete', async () => {
    const query = "fullText contains 'FAKE'";
    const full = await pageAll('search_files', { query }, 100);
    const order = full.map((f) => f.account as string);
    expect(order.indexOf('prime')).toBeGreaterThan(order.lastIndexOf('stratify'));
    expect(order).toContain('stratify');
    expect(new Set(full.map((f) => f.id)).size).toBe(full.length);
  });

  // A later account skips files owned by an earlier one, so the shared doc is listed once even across pages.
  it('4b. fullText paging at pageSize 2 has no duplicates', async () => {
    const query = "fullText contains 'FAKE'";
    const full = await pageAll('search_files', { query }, 100);
    const seen = await pageAll('search_files', { query }, 2);
    const ids = seen.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(full.map((f) => f.id)));
    const sOrder = seen.map((f) => f.account as string);
    expect(sOrder.indexOf('prime')).toBeGreaterThan(sOrder.lastIndexOf('stratify'));
  });

  it('5. query translation: supported terms work, raw syntax and injection are refused', async () => {
    const budget = await pageAll('search_files', { query: "title contains 'Budget'" }, 100);
    expect(budget.map((f) => f.id).sort()).toEqual(['p-sheet-budget', 's-sheet-budget']);
    const inProjects = (await call('search_files', { query: "parentId = 's-fld-projects'", account: 'stratify', pageSize: 100 })).sc.files as R[];
    expect(inProjects.map((f) => f.id)).toContain('s-doc-notes');
    expect(inProjects.every((f) => f.parentId === 's-fld-projects')).toBe(true);
    for (const query of ["'x' in parents", "title contains 'a' or trashed = true"]) {
      const r = await call('search_files', { query });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Cannot use this search query/);
    }
  });

  it('6. list_recent_files: each orderBy is monotonic on its field and pages correctly', async () => {
    const recency = (f: R) => Math.max(ms(f.modifiedTime), ms(f.viewedByMeTime), ms(f.sharedWithMeTime), ms(f.createdTime));
    for (const [orderBy, key] of [
      ['recency', recency],
      ['lastModified', (f: R) => ms(f.modifiedTime)],
    ] as const) {
      const full = await pageAll('list_recent_files', { orderBy }, 100);
      nonIncreasing(full.map(key));
      const paged = await pageAll('list_recent_files', { orderBy }, 4);
      const ids = paged.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids)).toEqual(new Set(full.map((f) => f.id)));
      nonIncreasing(paged.map(key));
    }
    expect(((await pageAll('list_recent_files', {}, 100)).filter((f) => f.id === 'shared-roadmap-doc'))).toHaveLength(1);
  });

  it('6b. list_recent_files lastModifiedByMe is monotonic on the modified-by-me time', async () => {
    // Only files the account owns carry a modified-by-me time in the fixtures; others sort last.
    const byMe = (f: R) => (f.owner === f.accountEmail ? ms(f.modifiedTime as string) : 0);
    const full = await pageAll('list_recent_files', { orderBy: 'lastModifiedByMe' }, 100);
    nonIncreasing(full.map(byMe));
    const paged = await pageAll('list_recent_files', { orderBy: 'lastModifiedByMe' }, 4);
    const ids = paged.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(full.map((f) => f.id)));
    nonIncreasing(paged.map(byMe));
  });

  it('7. metadata snippet sizes and permissions', async () => {
    const long = 'FAKE long text. '.repeat(400);
    const made = await call('create_file', { account: 'stratify', title: 'FAKE long', textContent: long, parentId: 's-fld-private' });
    const id = made.sc.id as string;
    const snip = async (a: R) => ((await call('get_file_metadata', { fileId: id, ...a })).sc.contentSnippet as string | undefined)?.length;
    expect(await snip({ snippetVerbosity: 'BRIEF' })).toBe(1000);
    expect(await snip({})).toBe(long.length > 5000 ? 5000 : long.length);
    expect(await snip({ excludeContentSnippets: true })).toBeUndefined();
    const perms = await call('get_file_permissions', { fileId: 's-fld-shared' });
    expect(perms.isError).toBe(false);
    expect((perms.sc.permissions as R[]).map((p) => p.emailAddress)).toContain('someone@outside.example');
  });

  it('8. read_file_content by type', async () => {
    const doc = await call('read_file_content', { fileId: 's-doc-notes' });
    expect(doc.sc.fileContent).toMatch(/^FAKE meeting notes for stratify/);
    const sheet = await call('read_file_content', { fileId: 's-sheet-budget' });
    expect(sheet.sc.fileContent).toBe('item,amount\nrent,1000\ntools,250\n');
    const pdf = await call('read_file_content', { fileId: 's-pdf-fake' });
    expect(pdf.sc.fileContent).toContain('FAKE PDF TEXT');
    const png = await call('read_file_content', { fileId: 's-png-fake' });
    const img = png.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG_B64 });
    const docx = await call('read_file_content', { fileId: 's-docx-stub' });
    expect(docx.isError).toBe(false);
    expect(docx.sc.fileContent).toMatch(/download_file_content/);
  });

  it('9. download_file_content: PNG round trip, Doc as PDF; over-cap upload is refused', async () => {
    const png = await call('download_file_content', { fileId: 's-png-fake' });
    expect(png.sc).toMatchObject({ id: 's-png-fake', mimeType: 'image/png', content: PNG_B64 });
    const pdf = await call('download_file_content', { fileId: 's-doc-notes', exportMimeType: 'application/pdf' });
    expect(pdf.isError).toBe(false);
    expect(pdf.sc.mimeType).toBe('application/pdf');
    expect(Buffer.from(pdf.sc.content as string, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    // The 3 MB read cap cannot be reached through the mock (no file or fault exceeds it), so only the create-side cap is checked.
    const big = await call('create_file', { account: 'stratify', title: 'FAKE big', textContent: 'x'.repeat(3_000_001) });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/larger than 3 MB/);
  });

  it('10. create_file: private works and is searchable; shared is refused; root works; no account asks', async () => {
    const ok = await call('create_file', { account: 'stratify', title: 'FAKE new note', textContent: 'FAKE hello', parentId: 's-fld-private' });
    expect(ok.isError).toBe(false);
    expect(ok.sc).toMatchObject({ account: 'stratify', parentId: 's-fld-private' });
    const found = (await call('search_files', { query: "title contains 'FAKE new note'" })).sc.files as R[];
    expect(found.map((f) => f.id)).toContain(ok.sc.id);

    const before = await allIds();
    const refused = await call('create_file', { account: 'stratify', title: 'FAKE nope', textContent: 'x', parentId: 's-fld-shared' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/shared with other people/);
    expect(refused.text).toMatch(HAND_BACK);
    expect(await allIds()).toEqual(before);

    const root = await call('create_file', { account: 'stratify', title: 'FAKE root note', textContent: 'x', parentId: 'root' });
    expect(root.isError).toBe(false);
    expect(root.sc.parentId).toBe('root');

    const none = await call('create_file', { title: 'FAKE no account', textContent: 'x' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/which one/i);
    expect(none.text).toContain('stratify');
    expect(none.text).toContain('prime');
  });

  it('11. copy_file: shared destination and implicit shared destination are refused; private works', async () => {
    const before = await allIds();
    const toShared = await call('copy_file', { fileId: 's-doc-notes', parentId: 's-fld-shared' });
    expect(toShared.isError).toBe(true);
    expect(toShared.text).toMatch(/shared with other people/);
    const implicit = await call('copy_file', { fileId: 's-doc-shared' });
    expect(implicit.isError).toBe(true);
    expect(implicit.text).toMatch(/shared with other people/);
    expect(await allIds()).toEqual(before);

    const ok = await call('copy_file', { fileId: 's-doc-notes', parentId: 's-fld-private', title: 'FAKE copy' });
    expect(ok.isError).toBe(false);
    expect(ok.sc).toMatchObject({ account: 'stratify', parentId: 's-fld-private', title: 'FAKE copy' });
    expect(ok.sc.id).not.toBe('s-doc-notes');
  });

  it('12. update_file: rename, refused move into shared, move into private, rename inside shared', async () => {
    const rename = await call('update_file', { fileId: 's-doc-notes', title: 'FAKE renamed' });
    expect(rename.isError).toBe(false);
    expect(rename.sc).toMatchObject({ id: 's-doc-notes', title: 'FAKE renamed', parentId: 's-fld-projects' });
    const toShared = await call('update_file', { fileId: 's-doc-notes', parentId: 's-fld-shared' });
    expect(toShared.isError).toBe(true);
    expect(toShared.text).toMatch(/shared with other people/);
    expect(toShared.text).toMatch(HAND_BACK);
    expect(((await call('get_file_metadata', { fileId: 's-doc-notes' })).sc.parentId)).toBe('s-fld-projects');
    const toPrivate = await call('update_file', { fileId: 's-doc-notes', parentId: 's-fld-private' });
    expect(toPrivate.isError).toBe(false);
    expect(toPrivate.sc.parentId).toBe('s-fld-private');
    const inShared = await call('update_file', { fileId: 's-doc-shared', title: 'FAKE renamed in shared' });
    expect(inShared.isError).toBe(false);
    expect(inShared.sc).toMatchObject({ title: 'FAKE renamed in shared', parentId: 's-fld-shared' });
  });

  it('13a. prime invalid_grant keeps stratify results and reports needs_reconnect', async () => {
    setMockFaults({ prime: 'invalid_grant' });
    const r = await call('search_files', { pageSize: 50 });
    expect(r.isError).toBe(false);
    const files = r.sc.files as R[];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.account === 'stratify')).toBe(true);
    expect(r.sc.accountErrors).toEqual([expect.objectContaining({ account: 'prime', kind: 'needs_reconnect' })]);
  });

  it('13b. prime timeout gives a timeout accountError and stratify results', async () => {
    const real = ctx.fanout;
    ctx.fanout = { ...real, read: (spec) => real.read({ ...spec, timeoutMs: 100 }) };
    setMockFaults({ prime: 'timeout' });
    const r = await call('search_files', { pageSize: 50 });
    expect(r.isError).toBe(false);
    expect((r.sc.files as R[]).every((f) => f.account === 'stratify')).toBe(true);
    expect(r.sc.accountErrors).toEqual([expect.objectContaining({ account: 'prime', kind: 'timeout' })]);
  });
});
