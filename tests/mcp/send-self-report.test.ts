import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailError, ProviderError, AccountSelectionError } from '@/core/errors';
import { mockSentMessages, resetMockGmail } from '@/google/mock/gmail';
import { resetMockFaults } from '@/google/mock/faults';
import { createSendSelfReportTool, DAILY_LIMIT, startOfTorontoDay } from '@/mcp/tools/gmail/send_self_report';
import { getToolDefs } from '@/mcp/registry';
import { parseEnv } from '@/lib/env';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';
import { createCipher } from '@/lib/crypto';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let ctx: ServerContext;
let clock = new Date('2026-10-16T15:00:00Z');
const tool = createSendSelfReportTool(() => clock);
const run = async (args: Record<string, unknown>, c: ServerContext = ctx) => (await tool.handler(tool.input.parse(args) as never, c)) as Record<string, unknown>;
const send = (over: Record<string, unknown> = {}) => run({ account: 'stratify', subject: 'Brief', body: 'Plain prose.', ...over });
const setClock = (iso: string) => {
  clock = new Date(iso);
  vi.setSystemTime(clock); // the memory store stamps audit rows with the real clock
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setClock('2026-10-16T15:00:00Z');
  resetMockGmail();
  resetMockFaults();
  const env = parseEnv({ GOOGLE_MODE: 'mock', STORE: 'memory', SESSION_SECRET: 's'.repeat(40), ADMIN_EMAILS: 'a@x.test', PUBLIC_BASE_URL: 'https://mcp.test' });
  ctx = await createServerContext({ env, store: createMemoryStore(createCipher(Buffer.alloc(32, 5).toString('base64'))), log: quiet });
});
afterEach(() => vi.useRealTimers());

const auditRows = () => (ctx.store as unknown as { _dump(): { audit: { tool: string; account: string; outcome: string; detail?: string }[] } })._dump().audit;

describe('send_self_report', () => {
  it('sends to the account\'s own address, records it in the mock, and counts', async () => {
    const r = await send({ htmlBody: '<p>hi</p>' });
    expect(r).toMatchObject({ sent: true, to: 'seb@stratify.example', sentToday: 1, dailyLimit: 6, account: 'stratify', accountEmail: 'seb@stratify.example' });
    expect(typeof r.messageId).toBe('string');
    const sent = mockSentMessages('stratify');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toRecipients: ['seb@stratify.example'], sender: 'seb@stratify.example', subject: 'Brief', plaintextBody: 'Plain prose.', htmlBody: '<p>hi</p>' });
    expect(sent[0]!.ccRecipients).toBeUndefined();
    expect(mockSentMessages('prime')).toHaveLength(0);
    expect((await send()).sentToday).toBe(2);
  });

  it('the recipient follows the named account', async () => {
    const r = await send({ account: 'prime' });
    expect(r.to).toBe('seb@prime.example');
    expect(mockSentMessages('prime')[0]!.toRecipients).toEqual(['seb@prime.example']);
  });

  it('refuses a missing account, "all" and a list', async () => {
    await expect(run({ subject: 's', body: 'b' })).rejects.toThrow(); // schema
    await expect(send({ account: 'all' })).rejects.toBeInstanceOf(GuardrailError);
    await expect(send({ account: 'ALL' })).rejects.toBeInstanceOf(GuardrailError);
    await expect(send({ account: ['stratify', 'prime'] })).rejects.toThrow(); // schema: string only
    // even a list that gets past the schema is refused by resolveWriteAccount (two accounts)
    await expect(tool.handler({ account: ['stratify', 'prime'], subject: 's', body: 'b' } as never, ctx)).rejects.toThrow();
    await expect(send({ account: 'nope' })).rejects.toBeInstanceOf(AccountSelectionError);
    expect(mockSentMessages('stratify')).toHaveLength(0);
    expect(mockSentMessages('prime')).toHaveLength(0);
  });

  it('refuses a "<" in body, and the refusal is audited without the body', async () => {
    const err = await send({ body: '<html>raw</html>' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as GuardrailError).rule).toBe('plain_text_body');
    expect((err as GuardrailError).message).toMatch(/htmlBody/);
    expect(mockSentMessages('stratify')).toHaveLength(0);
    expect(auditRows()).toEqual([expect.objectContaining({ tool: 'send_self_report', outcome: 'rejected', detail: 'plain_text_body' })]);
    expect(JSON.stringify(auditRows())).not.toContain('raw');
    await expect(send({ body: 'a < b' })).rejects.toBeInstanceOf(GuardrailError);
    await expect(send({ body: 'fine', htmlBody: '<p>ok</p>' })).resolves.toMatchObject({ sent: true });
  });

  it('refuses a message over 1.5 MB in total', async () => {
    const err = await send({ body: 'x'.repeat(1_000_000), htmlBody: 'y'.repeat(600_000) }).catch((e: unknown) => e);
    expect((err as GuardrailError).rule).toBe('too_large');
    await expect(send({ body: 'x'.repeat(1_000_000), htmlBody: 'y'.repeat(400_000) })).resolves.toMatchObject({ sent: true });
  });

  it.each(['to', 'cc', 'bcc', 'from', 'replyTo', 'headers', 'threadId', 'attachments'])('%s in the input is a schema error', async (key) => {
    const args = { account: 'stratify', subject: 's', body: 'b', [key]: 'victim@evil.test' };
    expect(tool.input.safeParse(args).success).toBe(false);
    await expect(tool.handler(args as never, ctx)).rejects.toBeInstanceOf(GuardrailError); // the handler enforces it too
    expect(mockSentMessages('stratify')).toHaveLength(0);
  });

  it('the seventh send in a Toronto day is refused, and the count resets the next day', async () => {
    for (let i = 1; i <= DAILY_LIMIT; i++) expect((await send()).sentToday).toBe(i);
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as GuardrailError).rule).toBe('daily_limit');
    expect((err as GuardrailError).message).toMatch(/6 .*per account per day.*6 already used.*resets at 2026-10-17T04:00:00.000Z/);
    expect(mockSentMessages('stratify')).toHaveLength(6);
    await expect(send()).rejects.toBeInstanceOf(GuardrailError); // still refused
    // the other account has its own count
    await expect(send({ account: 'prime' })).resolves.toMatchObject({ sentToday: 1 });
    // 23:59 Toronto is still the same day; 00:00 Toronto is a new one
    setClock('2026-10-17T03:59:59Z');
    await expect(send()).rejects.toBeInstanceOf(GuardrailError);
    setClock('2026-10-17T04:00:00Z');
    expect((await send()).sentToday).toBe(1);
    expect(mockSentMessages('stratify')).toHaveLength(7);
  });

  it('a failed send still counts (the reservation stays) and is audited as an error', async () => {
    const failing = createSendSelfReportTool(() => clock);
    const c = { ...ctx, adapters: { ...ctx.adapters, gmail: () => ({ sendSelfReport: async () => { throw new ProviderError('upstream_error', 'x'); } }) } } as unknown as ServerContext;
    await expect(failing.handler({ account: 'stratify', subject: 's', body: 'b' } as never, c)).rejects.toBeInstanceOf(ProviderError);
    expect(auditRows().map((r) => `${r.outcome}:${r.detail}`)).toEqual(['ok:reserved', 'error:upstream_error']);
    expect((await send()).sentToday).toBe(2);
  });

  it('a failed reservation write sends nothing', async () => {
    const c = { ...ctx, store: { ...ctx.store, audit: { ...ctx.store.audit, write: async () => { throw new Error('db down'); } } } } as unknown as ServerContext;
    await expect(run({ account: 'stratify', subject: 's', body: 'b' }, c)).rejects.toThrow('db down');
    expect(mockSentMessages('stratify')).toHaveLength(0);
  });

  it('surfaces needs_reconnect', async () => {
    const acc = (await ctx.store.accounts.list()).find((a) => a.label === 'stratify')!;
    await ctx.store.accounts.setStatus(acc.id, 'needs_reconnect');
    await expect(send()).rejects.toMatchObject({ kind: 'needs_reconnect' });
    expect(mockSentMessages('stratify')).toHaveLength(0);
  });

  it('audit details stay within 200 characters and hold no content', async () => {
    await send({ subject: 'SECRET-SUBJECT', body: 'SECRET-BODY' });
    for (const r of auditRows()) expect((r.detail ?? '').length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(auditRows())).not.toMatch(/SECRET|seb@/);
  });

  it('is registered once, and its description states the self-only rule', () => {
    const defs = getToolDefs('http://x').filter((d) => d.name === 'send_self_report');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.description).toMatch(/OWN address and to nobody else/);
    expect(defs[0]!.description).toMatch(/6 per account per calendar day/);
    expect(defs[0]!.kind).toBe('write');
  });
});

describe('startOfTorontoDay', () => {
  it.each([
    ['2026-10-16T15:00:00Z', '2026-10-16T04:00:00.000Z'], // EDT
    ['2026-10-17T03:59:59Z', '2026-10-16T04:00:00.000Z'],
    ['2026-12-01T12:00:00Z', '2026-12-01T05:00:00.000Z'], // EST
    ['2026-11-01T20:00:00Z', '2026-11-01T04:00:00.000Z'], // fall-back day: midnight was still EDT
    ['2026-03-08T20:00:00Z', '2026-03-08T05:00:00.000Z'], // spring-forward day: midnight was EST
  ])('%s -> %s', (now, start) => {
    expect(startOfTorontoDay(new Date(now)).toISOString()).toBe(start);
  });
});
