// Response size, PDF safety and Drive name/type rules of download_gmail_attachment, through the real server.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { GuardrailError } from '@/core/errors';
import { buildServer, getToolDefs, type AnyToolDef } from '@/mcp/registry';
import { extractInWorker, extractPdfText, pdfExpandsTooMuch } from '@/mcp/tools/pdf-text';

const h = vi.hoisted(() => ({ text: '' as string, real: false }));
vi.mock('@/mcp/tools/pdf-text', async (orig) => {
  const m = await orig<typeof import('@/mcp/tools/pdf-text')>();
  return { ...m, extractPdfText: async (b: Uint8Array) => (h.real ? m.extractPdfText(b) : { ok: true, text: h.text }) };
});

const acct: Account = { id: 'i', provider: 'google', email: 'a@b.test', label: 'x', orgClientId: 'o', priority: 0, connectedAt: '', status: 'active', grantedScopes: [] };
let created: { title: string; content?: { contentType: string } }[];
const FOLDER = 'application/vnd.google-apps.folder';

function ctxFor(filename: string, mimeType: string, bytes: Uint8Array, createFile?: (p: { title: string }) => unknown): ToolContext {
  created = [];
  return {
    store: { accounts: { list: async () => [acct] }, audit: { write: async () => {} } },
    fanout: createFanOutEngine({ listAccounts: async () => [acct], cursorSecret: 's'.repeat(32), reconnectUrl: '/c' }),
    adapters: {
      gmail: () => ({ getMessage: async () => ({ id: 'm', threadId: 't', internalDate: '1', date: 'd', viewUrl: 'u', attachments: [{ id: 'a', filename, mimeType, size: bytes.length }] }), getAttachment: async () => bytes }),
      drive: () => ({
        searchFiles: async () => ({ items: [{ id: 'f', title: 'Superconnector attachments', mimeType: FOLDER }] }),
        isSharedFolder: async () => false,
        createFile: async (p: { title: string; content?: { contentType: string } }) => {
          created.push(p);
          if (createFile) return createFile(p);
          return { id: 'file1', title: p.title, mimeType: 'x' };
        },
      }),
    },
    adapterContext: (a: Account) => ({ account: a }),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ToolContext;
}
const def = () => getToolDefs('http://x').find((d) => d.name === 'download_gmail_attachment')!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const respond = async (ctx: ToolContext, args: object) => (buildServer(ctx, { defs: [def()], baseUrl: 'http://x' }) as any)._registeredTools.download_gmail_attachment.handler(args, {});
const wire = (res: unknown) => Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: res }));
const PDF3 = new Uint8Array(3_000_000);

beforeEach(() => { h.real = false; });

describe('M1: response size (3 MB PDF, text from the PDF, through the real server)', () => {
  it.each([
    ['CJK', '中'.repeat(200_000)],
    ['control characters', '\u0001'.repeat(200_000)],
    ['quotes and backslashes', '"\\'.repeat(100_000)],
    ['emoji', '😀'.repeat(100_000)],
  ])('%s stays at or under 4.5 MB and keeps the file', async (_n, text) => {
    h.text = text;
    const res = await respond(ctxFor('a.pdf', 'application/pdf', PDF3), { messageId: 'm' });
    expect(wire(res)).toBeLessThanOrEqual(4_500_000);
    expect(res.content.map((c: { type: string }) => c.type)).toEqual(['text', 'resource']);
    if (_n === 'control characters') expect(res.content[0].text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    if (_n !== 'control characters') expect(res.content[0].text).toContain('text cut');
  });

  it('a very long file name is cut to 255 characters in the text, meta and Drive title', async () => {
    h.text = 'hi';
    const long = '中'.repeat(50_000) + '.pdf';
    const res = await respond(ctxFor(long, 'application/pdf', PDF3), { messageId: 'm' });
    expect(wire(res)).toBeLessThanOrEqual(4_500_000);
    expect(res.structuredContent.attachment.filename).toHaveLength(255);
    expect(res.content[0].text).not.toContain('中'.repeat(256));
    await respond(ctxFor(long, 'application/pdf', PDF3), { messageId: 'm', saveToDrive: true });
    expect(created.at(-1)!.title.length).toBeLessThanOrEqual(200);
  });

  it('registry guard: an over-size result drops image and resource blocks and says what to do', async () => {
    const big = { uri: 'gmail-attachment://m/0', mimeType: 'text/csv', blob: 'A'.repeat(3_990_000) };
    const mk = (extra: object) => ({ name: 'x', description: 'd', input: z.object({}), kind: 'read', handler: async () => ({ mcpText: '中'.repeat(120_000), ...extra }) }) as unknown as AnyToolDef;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (d: AnyToolDef) => (buildServer(ctxFor('a', 'a/b', PDF3), { defs: [d], baseUrl: 'http://x' }) as any)._registeredTools.x.handler({}, {});
    const res = await run(mk({ mcpResource: big }));
    expect(res.content.map((c: { type: string }) => c.type)).toEqual(['text', 'text']);
    expect(res.content[1].text).toMatch(/too large to return.*saveToDrive.*download_file_content/);
    expect(wire(res)).toBeLessThan(4_300_000);
    const small = await run({ ...mk({}), handler: async () => ({ mcpText: 'ok', mcpResource: { ...big, blob: 'AAAA' } }) } as AnyToolDef);
    expect(small.content.map((c: { type: string }) => c.type)).toEqual(['text', 'resource']);
  });
});

describe('L2: Drive title, content type, refusal suffix', () => {
  it('the Drive title has control characters and quotes removed and is at most 200 characters', async () => {
    h.text = 'x';
    await respond(ctxFor('a\u0000b\nc"d' + 'e'.repeat(300) + '.pdf', 'application/pdf', new Uint8Array(5)), { messageId: 'm', saveToDrive: true });
    const t = created.at(-1)!.title;
    expect(t).toHaveLength(200);
    expect(t.startsWith('abcde')).toBe(true);
  });
  it.each(['application/x-a&b', 'text/a$b', 'a!b/c', 'application/a^b'])('a type with characters GoogleHttp.upload refuses (%s) becomes application/octet-stream', async (mt) => {
    await respond(ctxFor('a.bin', mt, new Uint8Array(5)), { messageId: 'm', saveToDrive: true });
    expect(created.at(-1)!.content!.contentType).toBe('application/octet-stream');
  });
  it('a blocked upload content type has no hand-back suffix; a share refusal still has it', async () => {
    const blocked = new GuardrailError('upload/content-type', 'GoogleHttp blocked the request: upload content type must be a plain type/subtype');
    const e = await respond(ctxFor('a.bin', 'a/b', new Uint8Array(5), () => { throw blocked; }), { messageId: 'm', saveToDrive: true });
    expect(e.isError).toBe(true);
    expect(e.content[0].text).not.toMatch(/Seb does this himself/);
    const other = new GuardrailError('share/x', 'blocked');
    const e2 = await respond(ctxFor('a.bin', 'a/b', new Uint8Array(5), () => { throw other; }), { messageId: 'm', saveToDrive: true });
    expect(e2.content[0].text).toMatch(/Seb does this himself/);
  });
});

function pdfWith(raw: Buffer, filters = '/FlateDecode'): Buffer {
  const z = deflateSync(raw, { level: 9 });
  const parts = ['%PDF-1.4\n', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n', `4 0 obj<</Length ${z.length}/Filter ${filters}>>stream\n`];
  return Buffer.concat([Buffer.from(parts.join('')), z, Buffer.from('\nendstream endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF')]);
}
const textPdf = () => pdfWith(Buffer.from('BT /F1 12 Tf 10 50 Td (Hello bomb test) Tj ET'));

describe('M2: PDF decompression bombs', () => {
  it.each([100, 400])('a %i MB bomb is refused by the pre-scan, fast and with bounded memory', async (mb) => {
    h.real = true;
    const bomb = pdfWith(Buffer.alloc(mb * 1_000_000, ' '));
    const rss = process.memoryUsage().rss;
    const t = Date.now();
    expect(pdfExpandsTooMuch(bomb)).toBe(true);
    expect(await extractPdfText(new Uint8Array(bomb))).toEqual({ ok: false, reason: 'expands' });
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(process.memoryUsage().rss - rss).toBeLessThan(250_000_000);
  });
  it('a double-Flate bomb is refused too, and many medium streams add up', () => {
    const inner = deflateSync(Buffer.alloc(40_000_000, ' '));
    expect(pdfExpandsTooMuch(pdfWith(Buffer.from(inner), '[/FlateDecode /FlateDecode]'))).toBe(false); // 2nd pass is the stream above: 40 MB < 64 MB
    expect(pdfExpandsTooMuch(textPdf(), 10)).toBe(true); // budget is a running total
    const many = Buffer.concat(Array.from({ length: 3 }, () => pdfWith(Buffer.alloc(30_000_000, ' '))));
    expect(pdfExpandsTooMuch(many)).toBe(true);
  });
  it('a corrupt stream is skipped, a normal PDF is not refused', () => {
    const z = pdfWith(Buffer.from('x'));
    const k = z.indexOf('stream\n') + 10;
    z[k] = (z[k] ?? 0) ^ 0xff;
    expect(pdfExpandsTooMuch(z)).toBe(false);
    expect(pdfExpandsTooMuch(textPdf())).toBe(false);
  });
  it('the Gmail tool says so in plain words and still returns the file', async () => {
    h.real = true;
    const res = await respond(ctxFor('b.pdf', 'application/pdf', new Uint8Array(pdfWith(Buffer.alloc(100_000_000, ' ')))), { messageId: 'm' });
    expect(res.content[0].text).toContain('this PDF expands too much to read safely; use saveToDrive or download it');
  });
});

const oomWorker = fileURLToPath(new URL('./oom-worker.fixture.mjs', import.meta.url));

describe('M2: worker isolation', () => {
  it('a normal PDF still extracts through the worker', async () => {
    h.real = true;
    const r = await extractPdfText(new Uint8Array(textPdf()));
    expect(r).toMatchObject({ ok: true });
    expect((r as { text: string }).text).toContain('Hello bomb test');
  });
  it('a timeout or an out-of-memory error in the worker gives "failed"', async () => {
    expect(await extractInWorker(new Uint8Array(textPdf()), { timeoutMs: 1 })).toEqual({ ok: false, reason: 'failed' });
    expect(await extractInWorker(new Uint8Array(textPdf()), { file: oomWorker })).toEqual({ ok: false, reason: 'failed' });
  });
});
