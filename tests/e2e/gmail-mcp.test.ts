// End-to-end Gmail tools through the real server stack in mock mode (OAuth bearer -> MCP client -> registry).
// The OAuth helpers are copied from oauth-mcp.test.ts (they are not exported there).
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockSentMessages, resetMockGmail } from '@/google/mock/gmail';
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
interface Res { isError?: boolean; text: string; sc: R }

let ctx: ServerContext;
let client: Client;
let texts: string[] = [];

async function call(name: string, args: R = {}): Promise<Res> {
  const r = (await client.callTool({ name, arguments: args })) as R;
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  texts.push(text);
  return { isError: r.isError === true, text, sc: (r.structuredContent ?? {}) as R };
}

beforeEach(async () => {
  resetMockGmail();
  resetMockFaults();
  texts = [];
  ctx = await makeCtx();
  const s = await runOAuthFlow(ctx);
  client = await connect(ctx, s.tokens.access_token);
});

// Case 13: no tool result in any test leaks credentials.
afterEach(() => {
  resetMockFaults();
  for (const t of texts) expect(t).not.toMatch(/access_token|refresh_token|Bearer/);
});

const dec = (hex: string) => BigInt(`0x${hex}`).toString();
const mail = (email: string) => `https://mail.google.com/mail/?authuser=${email}`;
const EMAIL: R = { stratify: 'seb@stratify.example', prime: 'seb@prime.example' };
const newest = (t: R) => Math.max(...(t.messages as R[]).map((m) => Number(m.internalDate)));
const nonIncreasing = (xs: number[]) => expect(xs).toEqual([...xs].sort((a, b) => b - a));
const TRASH_MSG = /never trashes/;
const HAND_BACK = /do not use another connector/;
const labelsOf = async (id: string) => ((await call('get_message', { messageId: id, messageFormat: 'METADATA_ONLY' })).sc.labelIds as string[]).slice().sort();

async function pageAll(args: R, pageSize: number): Promise<R[]> {
  const seen: R[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await call('search_threads', { ...args, pageSize, ...(cursor ? { pageToken: cursor } : {}) });
    expect(r.isError).toBe(false);
    seen.push(...(r.sc.threads as R[]));
    cursor = r.sc.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error('paging did not terminate');
}

describe('Gmail MCP end to end (mock mode)', () => {
  it('1. lists exactly the enabled tools and none of the excluded ones', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(names).toHaveLength(39);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
    for (const n of ['send_message', 'send_draft', 'reply', 'forward', 'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread', 'delete_draft', 'delete_label', 'create_filter']) {
      expect(names).not.toContain(n);
    }
  });

  it('2. search_threads fans out, newest first, tagged, shared email twice', async () => {
    const r = await call('search_threads', { pageSize: 50 });
    expect(r.isError).toBe(false);
    expect(r.sc.accountErrors).toEqual([]);
    const threads = r.sc.threads as R[];
    expect(threads).toHaveLength(50);
    expect(new Set(threads.map((t) => t.account))).toEqual(new Set(['stratify', 'prime']));
    for (const t of threads) {
      expect(t.accountEmail).toBe(EMAIL[t.account]);
    }
    nonIncreasing(threads.map(newest));
    const shared = threads.filter((t) => (t.messages as R[]).some((m) => m.subject === 'FAKE Shared launch notice'));
    expect(shared.map((t) => `${t.account}:${t.id}`).sort()).toEqual(['prime:19a7c0000004', 'stratify:18f2a0000004']);
  });

  it('3. paging with pageSize 10 sees all 52 visible threads once, in order', async () => {
    const seen = await pageAll({}, 10);
    const keys = seen.map((t) => `${t.account}|${t.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(seen).toHaveLength(26 + 26);
    expect(seen.filter((t) => t.account === 'stratify')).toHaveLength(26);
    expect(seen.filter((t) => t.account === 'prime')).toHaveLength(26);
    nonIncreasing(seen.map(newest));
    // Spam stays hidden.
    for (const t of seen) for (const m of t.messages as R[]) expect(m.labelIds).not.toContain('SPAM');
  });

  it('4. each format and view returns exactly the documented fields; viewUrl follows the formula', async () => {
    const base = ['id', 'threadId', 'historyId', 'internalDate', 'date', 'sender', 'toRecipients', 'labelIds', 'sizeEstimate', 'viewUrl', 'account', 'accountEmail'];
    const optional = ['ccRecipients', 'bccRecipients'];
    const keysOf = (o: R) => Object.keys(o).filter((k) => !optional.includes(k)).sort();
    const id = '19a7c0000003';
    const fmt = async (f: string) => (await call('get_message', { messageId: id, messageFormat: f })).sc;

    const meta = await fmt('METADATA_ONLY');
    expect(keysOf(meta)).toEqual([...base].sort());
    const minimal = await fmt('MINIMAL');
    expect(keysOf(minimal)).toEqual([...base, 'subject', 'snippet'].sort());
    const plain = await fmt('PLAIN_TEXT');
    expect(keysOf(plain)).toEqual([...base, 'subject', 'snippet', 'plaintextBody', 'attachmentIds', 'attachments'].sort());
    const full = await fmt('FULL_CONTENT');
    expect(keysOf(full).filter((k) => k !== 'htmlBody')).toEqual(keysOf(plain));
    expect(Object.keys(await fmt('MESSAGE_FORMAT_UNSPECIFIED'))).toEqual(Object.keys(full));
    expect(meta).not.toHaveProperty('subject');
    expect(meta).not.toHaveProperty('snippet');
    expect(meta).not.toHaveProperty('plaintextBody');
    expect(meta).not.toHaveProperty('htmlBody');
    expect(plain).not.toHaveProperty('htmlBody');
    expect((await call('get_message', { messageId: id, messageFormat: 'RAW' })).isError).toBe(true);

    expect(meta.account).toBe('prime');
    expect(meta.viewUrl).toBe(`${mail('seb@prime.example')}#all/thread-f:${dec('19a7c0000001')}|msg-f:${dec(id)}`);
    expect(meta.accountEmail).toBe('seb@prime.example');

    // Thread
    const th = (await call('get_thread', { threadId: '18f2a0000001', messageFormat: 'METADATA_ONLY' })).sc;
    expect(Object.keys(th).sort()).toEqual(['account', 'accountEmail', 'id', 'messageCount', 'messages', 'viewUrl']);
    expect(th.viewUrl).toBe(`${mail('seb@stratify.example')}#all/thread-f:${dec('18f2a0000001')}`);
    for (const m of th.messages as R[]) {
      expect(m).not.toHaveProperty('subject');
      expect(m).not.toHaveProperty('snippet');
      expect(m.viewUrl).toBe(`${mail('seb@stratify.example')}#all/thread-f:${dec('18f2a0000001')}|msg-f:${dec(m.id)}`);
    }

    // search views
    const sMeta = (await call('search_threads', { view: 'THREAD_VIEW_METADATA_ONLY', pageSize: 5 })).sc.threads as R[];
    const sMin = (await call('search_threads', { view: 'THREAD_VIEW_MINIMAL', pageSize: 5 })).sc.threads as R[];
    for (const t of sMeta) for (const m of t.messages as R[]) for (const k of ['subject', 'snippet', 'plaintextBody', 'htmlBody']) expect(m).not.toHaveProperty(k);
    for (const t of sMin) for (const m of t.messages as R[]) {
      expect(m.subject).toBeTruthy();
      expect(m.snippet).toBeTruthy();
      expect(m).not.toHaveProperty('plaintextBody');
    }

    // drafts
    const dMeta = (await call('get_draft', { draftId: 'r-1001', messageFormat: 'METADATA_ONLY' })).sc;
    expect(Object.keys(dMeta).sort()).toEqual(['account', 'accountEmail', 'date', 'id', 'labelIds', 'messageId', 'sender', 'threadId', 'toRecipients', 'viewUrl']);
    expect(dMeta.viewUrl).toBe(`${mail('seb@stratify.example')}#all?compose=thread-f:${dec('18f2a0000001')}%2Bmsg-a:r-1001`);
    expect(dMeta.labelIds).toEqual(['DRAFT']);
    const dFull = (await call('get_draft', { draftId: 'r-1001', messageFormat: 'FULL_CONTENT' })).sc;
    expect(dFull.subject).toBeTruthy();
    expect(dFull.plaintextBody).toBeTruthy();
    const listMeta = (await call('list_drafts', {})).sc.drafts as R[];
    for (const d of listMeta) {
      expect(d).not.toHaveProperty('subject');
      expect(d).not.toHaveProperty('plaintextBody');
    }
    const listFull = (await call('list_drafts', { view: 'DRAFT_VIEW_FULL' })).sc.drafts as R[];
    for (const d of listFull) expect(d.subject).toBeDefined();
  });

  it('5. lookups find the right account; unknown ids are a plain not-found result', async () => {
    const t1 = await call('get_thread', { threadId: '18f2a0000001' });
    expect(t1.sc).toMatchObject({ id: '18f2a0000001', account: 'stratify' });
    const t2 = await call('get_thread', { threadId: '19a7c0000001' });
    expect(t2.sc).toMatchObject({ id: '19a7c0000001', account: 'prime' });
    expect((await call('get_message', { messageId: '19a7c0000003' })).sc).toMatchObject({ id: '19a7c0000003', account: 'prime' });
    expect((await call('get_message', { messageId: '18f2a0000003' })).sc).toMatchObject({ id: '18f2a0000003', account: 'stratify' });
    expect((await call('get_draft', { draftId: 'r-2001' })).sc).toMatchObject({ id: 'r-2001', account: 'prime' });
    expect((await call('get_draft', { draftId: 'r-1001' })).sc).toMatchObject({ id: 'r-1001', account: 'stratify' });

    for (const [tool, args, what] of [
      ['get_thread', { threadId: 'ffffffffffff' }, 'thread'],
      ['get_message', { messageId: 'ffffffffffff' }, 'message'],
      ['get_draft', { draftId: 'r-9999' }, 'draft'],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError).toBe(false);
      expect(r.sc.message).toMatch(new RegExp(`No ${what} with that id was found`));
      expect(r.sc.accountErrors).toEqual([]);
      expect(r.text).not.toMatch(/Internal error/);
    }
  });

  it('6. reply draft with no account lands on prime in the original thread; nothing is sent', async () => {
    const r = await call('create_draft', { replyToMessageId: '19a7c0000003', body: 'FAKE reply body' });
    expect(r.isError).toBe(false);
    expect(r.sc).toMatchObject({ account: 'prime', accountEmail: 'seb@prime.example', threadId: '19a7c0000001', labelIds: ['DRAFT'] });
    expect(r.sc.toRecipients.length).toBeGreaterThan(0);
    const id = r.sc.id as string;

    const prime = (await call('list_drafts', { account: 'prime', pageSize: 50 })).sc.drafts as R[];
    expect(prime.map((d) => d.id)).toContain(id);
    expect(prime).toHaveLength(4);
    const strat = (await call('list_drafts', { account: 'stratify', pageSize: 50 })).sc.drafts as R[];
    expect(strat.map((d) => d.id)).not.toContain(id);
    expect(strat).toHaveLength(3);

    // Nothing sent: the thread gained no message.
    const orig = (await call('get_thread', { threadId: '19a7c0000001', account: 'prime' })).sc;
    const before = (await call('get_thread', { threadId: '18f2a0000001', account: 'stratify' })).sc;
    expect(orig.messageCount).toBe(before.messageCount);
    expect((orig.messages as R[]).map((m) => m.id)).not.toContain(r.sc.messageId);
  });

  it('7. create_draft with no account and no reply target asks which account', async () => {
    const r = await call('create_draft', { subject: 'FAKE x', body: 'FAKE' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/which one/i);
    expect(r.text).toContain('stratify');
    expect(r.text).toContain('prime');
    expect(((await call('list_drafts', { pageSize: 50 })).sc.drafts as R[])).toHaveLength(6);
  });

  it('8. update_draft merges: a subject-only update keeps the recipients', async () => {
    const before = (await call('get_draft', { draftId: 'r-1002', messageFormat: 'FULL_CONTENT' })).sc;
    expect(before.toRecipients).toEqual(['bob@client.test']);
    const r = await call('update_draft', { draftId: 'r-1002', subject: 'FAKE renamed draft' });
    expect(r.isError).toBe(false);
    expect(r.sc).toMatchObject({ id: 'r-1002', account: 'stratify', subject: 'FAKE renamed draft', toRecipients: ['bob@client.test'], ccRecipients: ['carla@partner.example'] });
    const after = (await call('get_draft', { draftId: 'r-1002', messageFormat: 'FULL_CONTENT' })).sc;
    expect(after).toMatchObject({ subject: 'FAKE renamed draft', plaintextBody: before.plaintextBody, toRecipients: ['bob@client.test'] });
  });

  it('9. TRASH is refused everywhere, in any casing, and labels stay unchanged', async () => {
    const mid = '18f2a0000003';
    const tid = '18f2a0000001';
    const before = await labelsOf(mid);
    const threadBefore = ((await call('get_thread', { threadId: tid, messageFormat: 'METADATA_ONLY' })).sc.messages as R[]).map((m) => [...m.labelIds].sort());
    const refused: Array<[string, R]> = [];
    for (const l of ['TRASH', 'trash', 'Trash', ' TRASH ']) {
      refused.push(
        ['label_message', { messageId: mid, labelIds: [l] }],
        ['label_message', { messageId: mid, labelIds: ['STARRED', l] }],
        ['label_thread', { threadId: tid, labelIds: [l] }],
        ['unlabel_message', { messageId: mid, labelIds: [l] }],
        ['unlabel_thread', { threadId: tid, labelIds: [l] }],
        ['update_message_labels', { messageId: mid, addLabelIds: [l] }],
        ['update_message_labels', { messageId: mid, removeLabelIds: [l] }],
        ['update_message_labels', { messageId: mid, addLabelIds: ['STARRED'], removeLabelIds: [l] }],
        ['apply_sensitive_message_label', { messageId: mid, labelOption: l }],
        ['apply_sensitive_thread_label', { threadId: tid, labelOption: l }],
      );
    }
    for (const [tool, args] of refused) {
      for (const account of [undefined, 'stratify']) {
        const r = await call(tool, { ...args, ...(account ? { account } : {}) });
        expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
        expect(r.text).toMatch(TRASH_MSG);
        expect(r.text).toMatch(HAND_BACK);
      }
    }
    expect(await labelsOf(mid)).toEqual(before);
    const threadAfter = ((await call('get_thread', { threadId: tid, messageFormat: 'METADATA_ONLY' })).sc.messages as R[]).map((m) => [...m.labelIds].sort());
    expect(threadAfter).toEqual(threadBefore);
    expect(before).not.toContain('STARRED');
  });

  it('10. spam round-trips on a thread; apply_sensitive SPAM works', async () => {
    const tid = '18f2a000000f'; // all-INBOX thread (Alpha holds a SENT message, which unmark would also move to INBOX)
    const read = async () => ((await call('get_thread', { threadId: tid, messageFormat: 'METADATA_ONLY' })).sc.messages as R[]).map((m) => [...m.labelIds].sort());
    const original = await read();
    for (const l of original) expect(l).toContain('INBOX');

    const marked = await call('mark_thread_spam', { threadId: tid });
    expect(marked.isError).toBe(false);
    expect(marked.sc.account).toBe('stratify');
    for (const m of marked.sc.messages as R[]) {
      expect(m.labelIds).toContain('SPAM');
      expect(m.labelIds).not.toContain('INBOX');
    }
    const afterMark = await read();
    for (const l of afterMark) {
      expect(l).toContain('SPAM');
      expect(l).not.toContain('INBOX');
    }

    const unmarked = await call('unmark_thread_spam', { threadId: tid });
    expect(unmarked.isError).toBe(false);
    for (const m of unmarked.sc.messages as R[]) {
      expect(m.labelIds).toContain('INBOX');
      expect(m.labelIds).not.toContain('SPAM');
    }
    expect(await read()).toEqual(original);

    const one = await call('apply_sensitive_message_label', { messageId: '18f2a000000d', labelOption: 'SPAM' });
    expect(one.isError).toBe(false);
    expect(one.sc.labelIds).toContain('SPAM');
    expect(one.sc.labelIds).not.toContain('INBOX');
    expect(await labelsOf('18f2a000000d')).toContain('SPAM');
    // Anything other than SPAM is refused.
    expect((await call('apply_sensitive_message_label', { messageId: '18f2a000000e', labelOption: 'STARRED' })).isError).toBe(true);
  });

  it('11. create, list, rename a label; system labels cannot be renamed', async () => {
    const created = await call('create_label', { displayName: 'Projects/Beta', account: 'stratify' });
    expect(created.isError).toBe(false);
    expect(created.sc).toMatchObject({ name: 'Projects/Beta', labelType: 'USER', account: 'stratify' });
    const labelId = created.sc.labelId as string;

    const all = (await call('list_labels')).sc.labels as R[];
    expect(all.filter((l) => l.name === 'Projects/Beta').map((l) => l.account)).toEqual(['stratify']);
    expect(all.find((l) => l.name === 'Projects/Alpha' && l.account === 'prime')).toBeTruthy();
    expect(all.find((l) => l.labelId === 'Label_2' && l.account === 'stratify')).toMatchObject({ name: 'Projects/Alpha', accountEmail: 'seb@stratify.example' });

    expect((await call('create_label', { displayName: 'Projects/NoAcct' })).isError).toBe(true);

    const renamed = await call('update_label', { labelId, displayName: 'Projects/Gamma', account: 'stratify' });
    expect(renamed.isError).toBe(false);
    expect(renamed.sc).toMatchObject({ labelId, name: 'Projects/Gamma' });
    const names = ((await call('list_labels', { account: 'stratify' })).sc.labels as R[]).map((l) => l.name);
    expect(names).toContain('Projects/Gamma');
    expect(names).not.toContain('Projects/Beta');

    const sys = await call('update_label', { labelId: 'INBOX', displayName: 'Renamed', account: 'stratify' });
    expect(sys.isError).toBe(true);
    expect(sys.text).not.toMatch(/Internal error/);
    expect(sys.text).toMatch(/System labels/);
    expect(((await call('list_labels', { account: 'stratify' })).sc.labels as R[]).find((l) => l.labelId === 'INBOX')).toMatchObject({ name: 'INBOX' });
  });

  it('12a. prime invalid_grant keeps stratify results and reports needs_reconnect', async () => {
    setMockFaults({ prime: 'invalid_grant' });
    const r = await call('search_threads', { pageSize: 50 });
    expect(r.isError).toBe(false);
    const threads = r.sc.threads as R[];
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.every((t) => t.account === 'stratify')).toBe(true);
    expect(r.sc.accountErrors).toEqual([expect.objectContaining({ account: 'prime', kind: 'needs_reconnect' })]);
    expect((r.sc.accountErrors as R[])[0]!.action).toBeTruthy();
    const labels = await call('list_labels');
    expect((labels.sc.labels as R[]).every((l) => l.account === 'stratify')).toBe(true);
  });

  it('12b. prime timeout gives a timeout accountError and stratify results', async () => {
    const real = ctx.fanout;
    ctx.fanout = { ...real, read: (spec) => real.read({ ...spec, timeoutMs: 100 }) };
    setMockFaults({ prime: 'timeout' });
    const r = await call('search_threads', { pageSize: 50 });
    expect(r.isError).toBe(false);
    expect((r.sc.threads as R[]).every((t) => t.account === 'stratify')).toBe(true);
    expect(r.sc.accountErrors).toEqual([expect.objectContaining({ account: 'prime', kind: 'timeout' })]);
  });

  it('12c. a write on a disconnected account gives a clear error', async () => {
    const prime = (await ctx.store.accounts.list()).find((a) => a.label === 'prime')!;
    await ctx.store.accounts.setStatus(prime.id, 'needs_reconnect');
    const r = await call('create_draft', { account: 'prime', body: 'FAKE' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/PRIME account disconnected/);
    expect(r.text).toMatch(/reconnect/);
    const m = await call('label_message', { messageId: '19a7c0000003', account: 'prime', labelIds: ['STARRED'] });
    expect(m.isError).toBe(true);
    expect(m.text).toMatch(/disconnected/);
    // The other account still writes.
    expect((await call('create_draft', { account: 'stratify', body: 'FAKE' })).isError).toBe(false);
  });

  it('12d. a write hitting invalid_grant is a clear error, not a crash', async () => {
    setMockFaults({ prime: 'invalid_grant' });
    const r = await call('create_draft', { account: 'prime', body: 'FAKE' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/reconnect/i);
    expect(r.text).not.toMatch(/Internal error/);
  });

  it('14. send_self_report emails only the account itself, shows in mock sent, and refuses the seventh', async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === 'send_self_report')!;
    expect(Object.keys(schema.inputSchema.properties as R).sort()).toEqual(['account', 'body', 'htmlBody', 'subject']);
    expect(schema.description).toMatch(/OWN address and to nobody else/);

    // No recipient can be expressed, and a missing / fan-out account is refused. Nothing is sent by any of these.
    for (const bad of [{ to: 'victim@evil.test' }, { cc: 'v@evil.test' }, { bcc: 'v@evil.test' }, { from: 'v@evil.test' }]) {
      expect((await call('send_self_report', { account: 'stratify', subject: 's', body: 'b', ...bad })).isError).toBe(true);
    }
    expect((await call('send_self_report', { subject: 's', body: 'b' })).isError).toBe(true);
    const all = await call('send_self_report', { account: 'all', subject: 's', body: 'b' });
    expect(all.isError).toBe(true);
    const html = await call('send_self_report', { account: 'stratify', subject: 's', body: '<b>x</b>' });
    expect(html.isError).toBe(true);
    expect(html.text).toMatch(/htmlBody/);
    expect(mockSentMessages('stratify')).toHaveLength(0);

    const first = await call('send_self_report', { account: 'stratify', subject: 'Morning brief', body: 'All quiet.', htmlBody: '<p>All quiet.</p>' });
    expect(first.isError).toBe(false);
    expect(first.sc).toMatchObject({ sent: true, to: EMAIL.stratify, sentToday: 1, dailyLimit: 6, account: 'stratify', accountEmail: EMAIL.stratify });
    const sent = mockSentMessages('stratify');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: first.sc.messageId, toRecipients: [EMAIL.stratify], subject: 'Morning brief' });
    expect(mockSentMessages('prime')).toHaveLength(0);

    for (let i = 2; i <= 6; i++) expect((await call('send_self_report', { account: 'stratify', subject: 's', body: 'b' })).sc.sentToday).toBe(i);
    const seventh = await call('send_self_report', { account: 'stratify', subject: 's', body: 'b' });
    expect(seventh.isError).toBe(true);
    expect(seventh.text).toMatch(/Daily limit reached.*6 already used today.*resets at/);
    expect(mockSentMessages('stratify')).toHaveLength(6);
  });
});
