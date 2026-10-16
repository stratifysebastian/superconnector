import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountSelectionError } from '@/core/errors';
import type { LogEvent } from '@/core/contracts/tool';
import { createCipher } from '@/lib/crypto';
import { parseEnv } from '@/lib/env';
import { handleMcpRequest, type McpDeps } from '@/mcp/handler';
import type { AnyToolDef } from '@/mcp/registry';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';
import { assertNoExcludedTools } from '../contract/excluded';

const BASE = 'http://localhost:3000';
const MCP_URL = `${BASE}/api/mcp`;
const logs: LogEvent[] = [];
let ctx: ServerContext;

beforeEach(async () => {
  logs.length = 0;
  const log = {
    info: (e: LogEvent) => void logs.push(e),
    warn: (e: LogEvent) => void logs.push(e),
    error: (e: LogEvent) => void logs.push(e),
  };
  const store = createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64')));
  ctx = await createServerContext({ env: parseEnv({ GOOGLE_MODE: 'mock' }), store, log });
});

const verifyOk: McpDeps['verify'] = async () => ({ subject: 'seb@example.test', clientId: 'c1' });

async function connect(deps: McpDeps = {}): Promise<Client> {
  const merged: McpDeps = { ctx, verify: verifyOk, ...deps };
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init), merged),
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

async function callListAccounts(client: Client) {
  const res = await client.callTool({ name: 'list_accounts', arguments: {} });
  return res.structuredContent as { accounts: Array<Record<string, unknown>> };
}

describe('/api/mcp handler', () => {
  it('returns 401 with WWW-Authenticate when there is no token', async () => {
    const res = await handleMcpRequest(new Request(MCP_URL, { method: 'POST', body: '{}' }), {
      ctx,
      verify: async () => null,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });

  it.each(['GET', 'DELETE'])('%s returns 405 with Allow: POST', async (method) => {
    const res = await handleMcpRequest(new Request(MCP_URL, { method }), { ctx, verify: verifyOk });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('lists exactly list_accounts and no excluded tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['list_accounts']);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
  });

  it('list_accounts returns stratify then prime with all products', async () => {
    const client = await connect();
    const { accounts } = await callListAccounts(client);
    expect(accounts.map((a) => [a.label, a.priority, a.status])).toEqual([
      ['stratify', 1, 'active'],
      ['prime', 2, 'active'],
    ]);
    for (const a of accounts) {
      expect(a.products).toEqual(['calendar', 'gmail', 'drive', 'docs', 'sheets', 'slides']);
      expect(a.missingProducts).toEqual([]);
      expect(a).not.toHaveProperty('reconnectUrl');
    }
  });

  it('flags a needs_reconnect account with a reconnect URL', async () => {
    const prime = (await ctx.store.accounts.list()).find((a) => a.label === 'prime')!;
    await ctx.store.accounts.setStatus(prime.id, 'needs_reconnect');
    const { accounts } = await callListAccounts(await connect());
    expect(accounts[1]).toMatchObject({ label: 'prime', status: 'needs_reconnect', reconnectUrl: `${BASE}/connect` });
    expect(accounts[0]).not.toHaveProperty('reconnectUrl');
  });

  it('result contains no ids, scope URLs or token keys', async () => {
    const res = await (await connect()).callTool({ name: 'list_accounts', arguments: {} });
    const text = JSON.stringify(res);
    const ids = (await ctx.store.accounts.list()).flatMap((a) => [a.id, a.orgClientId]);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toContain('https://www.googleapis.com');
    expect(text.toLowerCase()).not.toContain('token');
    expect(text).not.toContain('fake-client');
  });

  it('returns "Internal error" for unknown errors, without the message, and logs only the kind', async () => {
    const defs: AnyToolDef[] = [
      {
        name: 'boom',
        description: 'throws',
        input: z.object({}),
        kind: 'read',
        handler: async () => {
          throw new Error('secret-detail ya29.leak');
        },
      },
      {
        name: 'pick',
        description: 'selection error',
        input: z.object({}),
        kind: 'read',
        handler: async () => {
          throw new AccountSelectionError('Which account? Use stratify or prime.', ['stratify', 'prime']);
        },
      },
    ];
    const client = await connect({ defs });
    const boom = await client.callTool({ name: 'boom', arguments: {} });
    expect(boom.isError).toBe(true);
    expect(JSON.stringify(boom)).toContain('Internal error');
    expect(JSON.stringify(boom)).not.toContain('secret-detail');
    expect(JSON.stringify(logs)).not.toContain('secret-detail');
    expect(logs.find((l) => l.tool === 'boom')).toMatchObject({ outcome: 'error', kind: 'Error', subject: 'seb@example.test' });

    const pick = await client.callTool({ name: 'pick', arguments: {} });
    expect(pick.isError).toBe(true);
    expect(JSON.stringify(pick)).toContain('Which account? Use stratify or prime.');
  });

  it('logs tool, duration and outcome for successful calls', async () => {
    await callListAccounts(await connect());
    const entry = logs.find((l) => l.tool === 'list_accounts');
    expect(entry).toMatchObject({ outcome: 'ok' });
    expect(typeof entry?.durationMs).toBe('number');
  });
});
