// download_gmail_attachment against the mock Gmail and Drive adapters and their fixtures (no network).
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockDrive } from '@/google/mock/drive';
import { resetMockFaults } from '@/google/mock/faults';
import { resetMockGmail } from '@/google/mock/gmail';
import { getToolDefs } from '@/mcp/registry';
import { parseEnv } from '@/lib/env';
import { createCipher } from '@/lib/crypto';
import { createServerContext, type ServerContext } from '@/server/context';
import { createMemoryStore } from '@/store/memory';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let ctx: ServerContext;

beforeEach(async () => {
  resetMockGmail();
  resetMockDrive();
  resetMockFaults();
  const env = parseEnv({ GOOGLE_MODE: 'mock', STORE: 'memory', SESSION_SECRET: 's'.repeat(40), ADMIN_EMAILS: 'a@x.test', PUBLIC_BASE_URL: 'https://mcp.test' });
  ctx = await createServerContext({ env, store: createMemoryStore(createCipher(Buffer.alloc(32, 5).toString('base64'))), log: quiet });
});

const def = () => getToolDefs('http://x').find((d) => d.name === 'download_gmail_attachment')!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (args: Record<string, unknown>) => def().handler(def().input.parse(args) as never, ctx) as Promise<any>;
const auditRows = () => (ctx.store as unknown as { _dump(): { audit: { tool: string; account: string; outcome: string }[] } })._dump().audit;
const driveFolders = async (account: string) => {
  const acct = (await ctx.store.accounts.list()).find((a) => a.label === account)!;
  return (await ctx.adapters.drive(ctx.adapterContext(acct)).searchFiles({ q: "name = 'Superconnector attachments' and 'root' in parents", pageSize: 10, orderByModified: false })).items;
};

describe('download_gmail_attachment (mock mode)', () => {
  it('PDF, image, CSV and the ambiguous message', async () => {
    expect((await call({ messageId: '18f2a0000007' })).mcpText).toMatch(/^Could not tell which attachment[^\n]*2:\n0\. "FAKE-report\.pdf"/);
    const pdf = await call({ messageId: '18f2a0000007', attachmentIndex: 0 });
    expect(pdf.mcpText).toContain('FAKE PDF TEXT');
    expect(pdf.mcpResource.uri).toBe('gmail-attachment://18f2a0000007/0');
    expect((await call({ messageId: '18f2a0000007', filename: 'FAKE-chart.png' })).mcpImage.mimeType).toBe('image/png');
    const csv = await call({ messageId: '18f2a0000008' });
    expect(csv.mcpResource.mimeType).toBe('text/csv');
    expect(Buffer.from(csv.mcpResource.blob, 'base64').toString()).toContain('FAKE widget');
    // the other account's message is found without naming the account
    expect(await call({ messageId: '19a7c0000008' })).toMatchObject({ account: 'prime', accountEmail: 'seb@prime.example' });
  });

  it('the large attachment is refused inline, the huge one is refused outright', async () => {
    expect((await call({ messageId: '18f2a0000009' })).mcpText).toMatch(/too big to return directly.*saveToDrive: true/s);
    await expect(call({ messageId: '18f2a000000a' })).rejects.toThrow(/larger than 12 MB/);
    await expect(call({ messageId: '18f2a000000a', saveToDrive: true })).rejects.toThrow(/larger than 12 MB/);
  });

  it('saveToDrive creates the folder in the right account\'s Drive once and reuses it', async () => {
    const a = await call({ messageId: '18f2a0000009', saveToDrive: true });
    const b = await call({ messageId: '18f2a0000008', saveToDrive: true });
    expect(a.file.title).toBe('FAKE-large.bin');
    expect(b.file.title).toBe('FAKE-orders.csv');
    const folders = await driveFolders('stratify');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ title: 'Superconnector attachments', mimeType: 'application/vnd.google-apps.folder' });
    expect(await driveFolders('prime')).toHaveLength(0);
    const rows = auditRows().filter((r) => r.tool === 'download_gmail_attachment');
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok']); // folder, file, file
    expect(rows.every((r) => r.account === 'stratify')).toBe(true);
  });
});
