import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntuitHttp } from '../../src/core/contracts/adapter';
import { createCipher } from '../../src/lib/crypto';
import { parseEnv } from '../../src/lib/env';
import { getToolDefs } from '../../src/mcp/registry';
import { createLiveQuickBooksAdapter } from '../../src/intuit/quickbooks';
import { createServerContext, type ServerContext } from '../../src/server/context';
import { createMemoryStore } from '../../src/store/memory';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';

let ctx: ServerContext;
beforeEach(async () => {
  ctx = await createServerContext({
    env: parseEnv({ GOOGLE_MODE: 'mock' }),
    store: createMemoryStore(createCipher(Buffer.alloc(32, 7).toString('base64'))),
    log: { info() {}, warn() {}, error() {} },
  });
});

describe('QuickBooks adapters', () => {
  it('mock mode seeds stratify-ca (mock-realm-1) and serves companyinfo from the fixture', async () => {
    const acct = (await ctx.store.accounts.list()).find((a) => a.provider === 'intuit')!;
    expect(acct).toMatchObject({ label: 'stratify-ca', realmId: 'mock-realm-1', email: 'books@stratify-ca.example', status: 'active' });
    const info = await ctx.adapters.quickbooks(ctx.quickbooksContext(acct)).companyInfo();
    expect(info).toMatchObject({ CompanyName: expect.stringContaining('Stratify Software Canada'), Country: 'CA' });
    expect(info.Email?.Address).toBe('books@stratify-ca.example');
    expect(await ctx.tokens.getAccessToken(acct)).toBe('mock-access-stratify-ca');
  });

  it('the live adapter reads CompanyInfo through IntuitHttp at the account\'s own realm', async () => {
    const acct = (await ctx.store.accounts.list()).find((a) => a.provider === 'intuit')!;
    const json = vi.fn(async () => ({ CompanyInfo: { CompanyName: 'X' } }));
    const http = { json } as unknown as IntuitHttp;
    const info = await createLiveQuickBooksAdapter({ account: acct, http, signal: new AbortController().signal }).companyInfo();
    expect(info).toEqual({ CompanyName: 'X' });
    expect(json).toHaveBeenCalledWith({ method: 'GET', path: '/v3/company/mock-realm-1/companyinfo/mock-realm-1' });
  });

  it('registers 60 tools: 21 QuickBooks (provider intuit), list_accounts (any) and the rest Google', () => {
    const defs = getToolDefs('http://x');
    expect(defs).toHaveLength(60);
    expect(ENABLED_TOOL_NAMES).toHaveLength(60);
    const intuit = defs.filter((d) => d.provider === 'intuit');
    expect(intuit).toHaveLength(21);
    for (const d of defs.filter((x) => x.provider !== 'intuit')) expect(d.provider ?? 'google').toBe(d.name === 'list_accounts' ? 'any' : 'google');
  });

  it('a real Google tool cannot be pointed at the QuickBooks company', async () => {
    const def = getToolDefs('http://x').find((d) => d.name === 'list_events')!;
    const { scopeToolContext } = await import('../../src/core/scope');
    const scoped = scopeToolContext(ctx, 'google');
    await expect(def.handler(def.input.parse({ account: 'stratify-ca' }) as never, scoped)).rejects.toThrow(/Unknown account/);
  });
});
