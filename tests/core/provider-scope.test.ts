import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../src/core/contracts/account';
import type { ToolContext, ToolDef } from '../../src/core/contracts/tool';
import { QUICKBOOKS_SCOPE } from '../../src/core/products';
import { createCipher } from '../../src/lib/crypto';
import { parseEnv } from '../../src/lib/env';
import { handleMcpRequest } from '../../src/mcp/handler';
import type { AnyToolDef } from '../../src/mcp/registry';
import { createServerContext, type ServerContext } from '../../src/server/context';
import { createMemoryStore } from '../../src/store/memory';

const MCP_URL = 'http://localhost:3000/api/mcp';
let ctx: ServerContext;

beforeEach(async () => {
  const store = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
  ctx = await createServerContext({ env: parseEnv({ GOOGLE_MODE: 'mock' }), store, log: { info() {}, warn() {}, error() {} } });
});

const input = z.object({ account: z.union([z.string(), z.array(z.string())]).optional() });

/** A tool that records which accounts each engine entry point reaches. */
function probe(name: string, provider?: ToolDef<typeof input>['provider']): AnyToolDef {
  return {
    name,
    description: 'probe',
    input,
    kind: 'read',
    ...(provider ? { provider } : {}),
    async handler({ account }: { account?: string | string[] }, c: ToolContext) {
      const fetched: string[] = [];
      const read = await c.fanout.read<{ n: number }>({
        selector: account,
        page: { pageSize: 10 },
        fetch: async (a: Account) => (fetched.push(a.label), { items: [{ n: 1 }] }),
        dateOf: () => 1,
      });
      return { fetched, labels: (await c.store.accounts.list()).map((a) => a.label), providers: read.items.map((i) => i.account) };
    },
  } as AnyToolDef;
}
const writeProbe = (name: string, provider?: ToolDef<typeof input>['provider']): AnyToolDef =>
  ({
    name, description: 'w', input, kind: 'write', ...(provider ? { provider } : {}),
    async handler({ account }: { account?: string | string[] }, c: ToolContext) {
      const a = await c.fanout.resolveWriteAccount(account);
      return { label: a.label, provider: a.provider };
    },
  }) as AnyToolDef;
const lookupProbe = (name: string, provider?: ToolDef<typeof input>['provider']): AnyToolDef =>
  ({
    name, description: 'l', input, kind: 'lookup', ...(provider ? { provider } : {}),
    async handler({ account }: { account?: string | string[] }, c: ToolContext) {
      const seen: string[] = [];
      const r = await c.fanout.lookup(account, async (a: Account) => (seen.push(a.label), { id: 'x' }));
      return { seen, hit: r.item?.account ?? null };
    },
  }) as AnyToolDef;

const DEFS = [
  probe('g_read'), // no provider: defaults to google
  probe('g_read_explicit', 'google'),
  probe('q_read', 'intuit'),
  writeProbe('g_write'),
  writeProbe('q_write', 'intuit'),
  lookupProbe('g_lookup'),
  lookupProbe('q_lookup', 'intuit'),
];

async function call(name: string, args: Record<string, unknown> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (i, init) => handleMcpRequest(new Request(i, init), { ctx, verify: async () => ({ subject: 's', clientId: 'c' }), defs: DEFS }),
  });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(transport);
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  return { isError: res.isError === true, text, data: res.isError ? undefined : (res.structuredContent as Record<string, unknown>) };
}

describe('provider scoping (enforced once, in the registry)', () => {
  it('a tool with no provider is a Google tool and never reaches a QuickBooks company', async () => {
    for (const name of ['g_read', 'g_read_explicit']) {
      const r = await call(name);
      expect(r.data).toMatchObject({ fetched: expect.arrayContaining(['stratify', 'prime']), labels: ['stratify', 'prime'] });
      expect(r.data!.fetched).not.toContain('stratify-ca');
    }
  });

  it('an Intuit tool never reaches a Google account', async () => {
    const r = await call('q_read');
    expect(r.data).toEqual({ fetched: ['stratify-ca'], labels: ['stratify-ca'], providers: ['stratify-ca'] });
  });

  it('a Google tool cannot select a QuickBooks company by label, email or list', async () => {
    for (const account of ['stratify-ca', 'books@stratify-ca.example', ['stratify', 'stratify-ca']]) {
      const r = await call('g_read', { account });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Unknown account/);
      expect(r.text).not.toContain('stratify-ca,');
    }
  });

  it('an Intuit tool cannot select a Google account by label, email or list', async () => {
    for (const account of ['stratify', 'prime', 'seb@stratify.example', ['stratify-ca', 'prime']]) {
      const r = await call('q_read', { account });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Unknown account/);
    }
    expect((await call('q_read', { account: 'stratify-ca' })).data!.fetched).toEqual(['stratify-ca']);
  });

  it('writes: each provider can only write to its own accounts, both directions', async () => {
    expect((await call('g_write', { account: 'stratify' })).data).toEqual({ label: 'stratify', provider: 'google' });
    expect((await call('q_write', { account: 'stratify-ca' })).data).toEqual({ label: 'stratify-ca', provider: 'intuit' });
    expect((await call('g_write', { account: 'stratify-ca' })).isError).toBe(true);
    expect((await call('q_write', { account: 'stratify' })).isError).toBe(true);
    expect((await call('q_write', { account: 'prime' })).isError).toBe(true);
    // 'all' stays inside the provider: three accounts exist, but each side sees only its own
    expect((await call('g_write', { account: 'all' })).text).toMatch(/exactly one account. Which one: stratify or prime/);
    expect((await call('q_write', { account: 'all' })).data).toEqual({ label: 'stratify-ca', provider: 'intuit' });
  });

  it('lookups try only the tool\'s own provider', async () => {
    expect((await call('g_lookup')).data).toEqual({ seen: ['stratify'], hit: 'stratify' });
    expect((await call('q_lookup')).data).toEqual({ seen: ['stratify-ca'], hit: 'stratify-ca' });
    expect((await call('g_lookup', { account: 'stratify-ca' })).isError).toBe(true);
    expect((await call('q_lookup', { account: 'prime' })).isError).toBe(true);
  });

  it('labels are per provider: a QuickBooks label can equal a Google label', async () => {
    const org = (await ctx.store.orgClients.list()).find((o) => o.provider === 'intuit')!;
    const q = await ctx.store.accounts.upsertOnConnect({
      provider: 'intuit', email: 'realm-2@intuit.local', label: 'stratify', orgClientId: org.id, grantedScopes: [QUICKBOOKS_SCOPE], realmId: 'realm-2',
    });
    expect(q.label).toBe('stratify');
    const g = await call('g_write', { account: 'stratify' });
    const i = await call('q_write', { account: 'stratify' });
    expect(g.data).toEqual({ label: 'stratify', provider: 'google' });
    expect(i.data).toEqual({ label: 'stratify', provider: 'intuit' });
    expect((await ctx.store.accounts.list()).filter((a) => a.label === 'stratify')).toHaveLength(2);
  });

  it('a write fallback that names another provider\'s account is rejected', async () => {
    const stray: AnyToolDef = {
      name: 'stray', description: 's', input, kind: 'write',
      async handler(_i: unknown, c: ToolContext) {
        const all = await ctx.store.accounts.list();
        const other = all.find((a) => a.provider === 'intuit')!;
        return c.fanout.resolveWriteAccount(undefined, async () => other);
      },
    } as AnyToolDef;
    DEFS.push(stray);
    try {
      expect((await call('stray')).isError).toBe(true);
    } finally {
      DEFS.pop();
    }
  });

  it('list_accounts is the only tool that sees every provider, and shows the provider', async () => {
    const { createListAccountsTool } = await import('../../src/mcp/tools/list_accounts');
    const list = createListAccountsTool('http://x');
    expect(list.provider).toBe('any');
    DEFS.push(list as unknown as AnyToolDef);
    try {
      const res = await call('list_accounts');
      expect((res.data!.accounts as { provider: string; label: string }[]).map((a) => [a.provider, a.label])).toEqual([
        ['google', 'stratify'], ['google', 'prime'], ['intuit', 'stratify-ca'],
      ]);
      expect(res.text).not.toContain('mock-realm-1');
    } finally {
      DEFS.pop();
    }
  });

  it('the adapter context builders refuse the wrong provider', async () => {
    const [g, , q] = await ctx.store.accounts.list();
    expect(() => ctx.adapterContext(q!)).toThrow();
    expect(() => ctx.quickbooksContext(g!)).toThrow();
    expect(ctx.adapterContext(g!).account.label).toBe('stratify');
    expect(ctx.quickbooksContext(q!).account.label).toBe('stratify-ca');
  });
});
