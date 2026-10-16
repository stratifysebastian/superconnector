// End-to-end Calendar tools through the real server stack in mock mode (OAuth bearer -> MCP client -> registry).
// The OAuth helpers are copied from oauth-mcp.test.ts (they are not exported there).
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockCalendar } from '@/google/mock/calendar';
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

async function call(name: string, args: R = {}): Promise<Res> {
  const r = (await client.callTool({ name, arguments: args })) as R;
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { isError: r.isError === true, text, sc: (r.structuredContent ?? {}) as R };
}

const WEEK = { startTime: '2026-10-19T00:00:00-04:00', endTime: '2026-10-26T00:00:00-04:00' };
const startOf = (e: R) => Date.parse(e.start.dateTime ?? e.start.date);
const sync = (events: R[]) => events.filter((e) => e.summary === 'FAKE Quarterly sync');

beforeEach(async () => {
  resetMockCalendar();
  resetMockFaults();
  ctx = await makeCtx();
  const s = await runOAuthFlow(ctx);
  client = await connect(ctx, s.tokens.access_token);
});

describe('Calendar MCP end to end (mock mode)', () => {
  it('lists exactly the enabled tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(names).toHaveLength(39);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
  });

  it('morning brief: both accounts, earliest first, shared meeting once', async () => {
    const r = await call('list_events', { ...WEEK, pageSize: 250 });
    expect(r.isError).toBe(false);
    const events = r.sc.events as R[];
    expect(r.sc.accountErrors).toEqual([]);
    expect(new Set(events.map((e) => e.account))).toEqual(new Set(['stratify', 'prime']));
    for (const e of events) {
      expect(e.account).toBeTruthy();
      expect(e.accountEmail).toBeTruthy();
    }
    const starts = events.map(startOf);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const shared = sync(events);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.accounts).toEqual(['stratify', 'prime']);
    expect(shared[0]!.sources.map((s: R) => s.id).sort()).toEqual(['prime-003', 'strat-003']);
    // 12 stratify + 12 prime events, minus one duplicate
    expect(events).toHaveLength(23);
  });

  it('pages with pageSize 4 and sees every event once in global order', async () => {
    const all = (await call('list_events', { ...WEEK, pageSize: 250 })).sc.events as R[];
    const seen: R[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await call('list_events', { ...WEEK, pageSize: 4, ...(cursor ? { pageToken: cursor } : {}) });
      expect(r.isError).toBe(false);
      seen.push(...(r.sc.events as R[]));
      cursor = r.sc.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    const keys = seen.map((e) => `${e.iCalUID}|${e.start.dateTime ?? e.start.date}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sync(seen)).toHaveLength(1);
    expect(seen).toHaveLength(all.length);
    const starts = seen.map(startOf);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('partial failure: invalid_grant on prime still returns stratify with a reconnect error', async () => {
    setMockFaults({ prime: 'invalid_grant' });
    const r = await call('list_events', { ...WEEK, pageSize: 250 });
    expect(r.isError).toBe(false);
    const events = r.sc.events as R[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.account === 'stratify')).toBe(true);
    const errs = r.sc.accountErrors as R[];
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ account: 'prime', kind: 'needs_reconnect' });
    expect(errs[0]!.action).toBeTruthy();
    // The mock token path never marks status, so list_accounts is not asserted on.
  });

  it('timeout: a hung prime does not block stratify results', async () => {
    const real = ctx.fanout;
    ctx.fanout = { ...real, read: (spec) => real.read({ ...spec, timeoutMs: 100 }) };
    setMockFaults({ prime: 'timeout' });
    const r = await call('list_events', { ...WEEK, pageSize: 250 });
    expect(r.isError).toBe(false);
    expect((r.sc.events as R[]).every((e) => e.account === 'stratify')).toBe(true);
    expect(r.sc.accountErrors).toEqual([expect.objectContaining({ account: 'prime', kind: 'timeout' })]);
  });

  it('selectors: label, email, and unknown account', async () => {
    const byLabel = (await call('list_events', { ...WEEK, pageSize: 250, account: 'prime' })).sc.events as R[];
    expect(new Set(byLabel.map((e) => e.account))).toEqual(new Set(['prime']));
    const byEmail = (await call('list_events', { ...WEEK, pageSize: 250, account: 'seb@stratify.example' })).sc.events as R[];
    expect(byEmail.length).toBeGreaterThan(0);
    expect(new Set(byEmail.map((e) => e.account))).toEqual(new Set(['stratify']));
    const bad = await call('list_events', { ...WEEK, account: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('stratify');
    expect(bad.text).toContain('prime');
  });

  it('get_event finds prime-003 on prime without an account', async () => {
    const r = await call('get_event', { eventId: 'prime-003' });
    expect(r.isError).toBe(false);
    expect(r.sc).toMatchObject({ id: 'prime-003', summary: 'FAKE Quarterly sync', account: 'prime' });
  });

  it('search_events finds the shared meeting once', async () => {
    // search starts 30 days before the real "now"; use a query the fixtures cannot hide from if dates are past.
    const r = await call('search_events', { query: 'Quarterly sync' });
    expect(r.isError).toBe(false);
    expect(sync(r.sc.events as R[])).toHaveLength(1);
  });

  it('create_event refuses attendees, asks for an account, and creates a solo event', async () => {
    const before = ((await call('list_events', { ...WEEK, pageSize: 250 })).sc.events as R[]).length;
    const guests = await call('create_event', {
      summary: 'FAKE With guest',
      ...{ startTime: '2026-10-22T13:00:00-04:00', endTime: '2026-10-22T13:30:00-04:00' },
      attendees: [{ email: 'x@y.test' }],
      account: 'stratify',
    });
    expect(guests.isError).toBe(true);
    expect(guests.text).toMatch(/never invites anyone/i);
    expect(((await call('list_events', { ...WEEK, pageSize: 250 })).sc.events as R[]).length).toBe(before);

    const noAcct = await call('create_event', { summary: 'FAKE x', startTime: '2026-10-22T13:00:00-04:00', endTime: '2026-10-22T13:30:00-04:00' });
    expect(noAcct.isError).toBe(true);
    expect(noAcct.text).toMatch(/which one/i);

    const ok = await call('create_event', {
      summary: 'FAKE Solo block',
      startTime: '2026-10-22T13:00:00-04:00',
      endTime: '2026-10-22T13:30:00-04:00',
      account: 'stratify',
    });
    expect(ok.isError).toBe(false);
    expect(ok.sc).toMatchObject({ summary: 'FAKE Solo block', account: 'stratify' });
    const after = (await call('list_events', { ...WEEK, pageSize: 250 })).sc.events as R[];
    expect(after.find((e) => e.summary === 'FAKE Solo block')).toMatchObject({ account: 'stratify' });
  });

  it('update_event refuses guest events, falls back to the holder, and refuses addedAttendees', async () => {
    const guest = await call('update_event', { eventId: 'strat-005', startTime: '2026-10-21T14:00:00-04:00', endTime: '2026-10-21T15:00:00-04:00' });
    expect(guest.isError).toBe(true);
    expect(guest.text).toMatch(/move it to 2026-10-21/);
    expect(guest.text).not.toContain('ext@client.example');
    const same = await call('get_event', { eventId: 'strat-005' });
    expect(same.sc.start.dateTime).toBe('2026-10-21T11:00:00-04:00');

    const solo = await call('update_event', { eventId: 'strat-007', summary: 'FAKE Write report v2' });
    expect(solo.isError).toBe(false);
    expect(solo.sc).toMatchObject({ summary: 'FAKE Write report v2', account: 'stratify' });
    expect((await call('get_event', { eventId: 'strat-007' })).sc.summary).toBe('FAKE Write report v2');

    const add = await call('update_event', { eventId: 'strat-007', account: 'stratify', addedAttendees: [{ email: 'x@y.test' }] });
    expect(add.isError).toBe(true);
  });

  it('suggest_time returns built-in-shaped slots that avoid busy events on both accounts', async () => {
    const r = await call('suggest_time', {
      attendeeEmails: [],
      startTime: '2026-10-20T00:00:00-04:00',
      endTime: '2026-10-21T00:00:00-04:00',
      durationMinutes: 60,
      preferences: { pageSize: 10 },
    });
    expect(r.isError).toBe(false);
    const slots = r.sc.timeSlots as R[];
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.start.dateTime).toBeTruthy();
      expect(s.startTime).toBeTruthy();
      expect(s.durationMinutes).toBeGreaterThanOrEqual(60);
    }
    const day = ((await call('list_events', { startTime: '2026-10-20T00:00:00-04:00', endTime: '2026-10-21T00:00:00-04:00', pageSize: 250 })).sc.events as R[]).filter(
      (e) => e.start.dateTime,
    );
    expect(day.length).toBe(4);
    for (const s of slots) {
      const a = Date.parse(s.startTime);
      const b = Date.parse(s.endTime);
      for (const e of day) expect(a < Date.parse(e.end.dateTime) && b > startOf(e)).toBe(false);
    }
  });

  it('list_calendars returns tagged calendars from both accounts', async () => {
    const r = await call('list_calendars');
    expect(r.isError).toBe(false);
    const cals = r.sc.calendars as R[];
    expect(new Set(cals.map((c) => c.account))).toEqual(new Set(['stratify', 'prime']));
    for (const c of cals) expect(c.accountEmail).toBeTruthy();
  });
});
