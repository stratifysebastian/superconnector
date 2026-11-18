import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { DriveAdapter, GFile } from '@/core/contracts/drive';
import type { GAttachmentMeta, GMessage, GmailAdapter } from '@/core/contracts/gmail';
import type { ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { GuardrailError } from '@/core/errors';
import { buildServer, getToolDefs, type AnyToolDef } from '@/mcp/registry';

const acct = (label: string, priority: number): Account => ({
  id: `id-${label}`, provider: 'google', email: `seb@${label}.test`, label, orgClientId: 'org', priority,
  connectedAt: '2026-01-01T00:00:00Z', status: 'active', grantedScopes: [],
});
const accounts = [acct('stratify', 0), acct('prime', 1)];
const FOLDER = 'application/vnd.google-apps.folder';
const PDF = new Uint8Array(Buffer.from(JSON.parse(readFileSync('fixtures/gmail/stratify/attachments.json', 'utf8'))['att-stratify-1'].contentBase64, 'base64'));
const SECRET_NAME = 'Secret-Name-Q3.pdf';

const att = (n: number, filename: string | undefined, mimeType: string, size?: number): GAttachmentMeta => ({ id: `a${n}`, ...(filename ? { filename } : {}), mimeType, ...(size !== undefined ? { size } : {}) });
const msg = (id: string, attachments: GAttachmentMeta[]): GMessage => ({ id, threadId: `t-${id}`, internalDate: '1', date: 'd', viewUrl: 'u', subject: 'Secret subject', attachments });

interface FakeGmail extends GmailAdapter { messages: GMessage[]; bytes: Record<string, Uint8Array> }
interface FakeDrive extends DriveAdapter { folders: GFile[]; shared: Set<string>; uploads: number }

const gFile = (id: string, title: string, mimeType: string): GFile => ({ id, title, mimeType, resourceUri: `googledrive://file/${id}`, viewUrl: `https://v/${id}` });

function makeGmail(): FakeGmail {
  const f = {
    messages: [], bytes: {},
    getMessage: vi.fn(async (p) => f.messages.find((m) => m.id === p.messageId) ?? null),
    getAttachment: vi.fn(async (p) => f.bytes[p.attachmentId ?? `#${p.index}`] ?? null),
  } as unknown as FakeGmail;
  return f;
}
function makeDrive(label: string): FakeDrive {
  const f = {
    folders: [], shared: new Set<string>(), uploads: 0,
    searchFiles: vi.fn(async () => ({ items: f.folders })),
    isSharedFolder: vi.fn(async (p) => f.shared.has(p.folderId)),
    createFile: vi.fn(async (p) => {
      if (p.mimeType === FOLDER) {
        const folder = gFile(`${label}-folder`, p.title, FOLDER);
        f.folders.push(folder);
        return folder;
      }
      return gFile(`${label}-file-${++f.uploads}`, p.title, p.content?.contentType ?? 'x');
    }),
  } as unknown as FakeDrive;
  return f;
}

let gm: Record<string, FakeGmail>;
let dr: Record<string, FakeDrive>;
let audit: { tool: string; account: string; targetId?: string; outcome: string }[];
let logs: unknown[];
let ctx: ToolContext;

beforeEach(() => {
  gm = { stratify: makeGmail(), prime: makeGmail() };
  dr = { stratify: makeDrive('stratify'), prime: makeDrive('prime') };
  audit = [];
  logs = [];
  const log = (e: unknown) => void logs.push(e);
  ctx = {
    store: { accounts: { list: async () => accounts }, audit: { write: async (e: (typeof audit)[number]) => void audit.push(e) } },
    fanout: createFanOutEngine({ listAccounts: async () => accounts, cursorSecret: 's'.repeat(32), reconnectUrl: '/connect' }),
    adapters: { gmail: (c: { account: Account }) => gm[c.account.label]!, drive: (c: { account: Account }) => dr[c.account.label]! },
    adapterContext: (account: Account) => ({ account }),
    log: { info: log, warn: log, error: log },
  } as unknown as ToolContext;
});

const tool = () => getToolDefs('http://x').find((d) => d.name === 'download_gmail_attachment')!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (args: Record<string, unknown>) => tool().handler(tool().input.parse(args) as never, ctx) as Promise<any>;
/** The server's real response for the tool (content blocks and structuredContent). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const respond = async (args: Record<string, unknown>) => (buildServer(ctx, { defs: [tool()], baseUrl: 'http://x' }) as any)._registeredTools.download_gmail_attachment.handler(args, {});

const three = () => {
  gm.stratify!.messages = [msg('m1', [att(1, 'one.pdf', 'application/pdf', 10), att(2, 'two.png', 'image/png', 10), att(3, 'two.png', 'text/csv', 10)])];
  gm.stratify!.bytes = { a1: PDF, a2: new Uint8Array([137, 80, 78, 71]), a3: new TextEncoder().encode('a,b\n1,2\n') };
};

describe('identifying the attachment', () => {
  beforeEach(three);

  it('attachmentIndex wins over everything else', async () => {
    const r = await call({ messageId: 'm1', attachmentIndex: 1, attachmentId: 'a1', filename: 'one.pdf' });
    expect(r.attachment).toMatchObject({ index: 1, filename: 'two.png', mimeType: 'image/png' });
    expect(gm.stratify!.getAttachment).toHaveBeenCalledWith({ messageId: 'm1', attachmentId: 'a2', index: 1 });
  });
  it('then attachmentId, then filename plus mimeType', async () => {
    expect((await call({ messageId: 'm1', attachmentId: 'a3' })).attachment.index).toBe(2);
    expect((await call({ messageId: 'm1', attachmentId: 'changed', filename: 'one.pdf' })).attachment.index).toBe(0); // stale id falls through
    expect((await call({ messageId: 'm1', filename: 'two.png', mimeType: 'text/csv' })).attachment.index).toBe(2);
  });
  it('an index past the end falls through to the next rule', async () => {
    expect((await call({ messageId: 'm1', attachmentIndex: 9, filename: 'one.pdf' })).attachment.index).toBe(0);
  });
  it('a named but unmatched request never falls back to the only attachment', async () => {
    gm.stratify!.messages = [msg('m2', [att(1, 'one.pdf', 'application/pdf')])];
    for (const args of [{ attachmentIndex: 9 }, { attachmentId: 'stale' }, { filename: 'invoice.pdf' }, { mimeType: 'text/csv' }]) {
      const r = await call({ messageId: 'm2', ...args });
      expect(r.mcpText).toMatch(/^Could not tell which attachment[^\n]*1:\n0\. "one\.pdf"/);
      expect(r.attachment).toBeUndefined();
    }
    expect(gm.stratify!.getAttachment).not.toHaveBeenCalled();
  });
  it('the only attachment needs no input', async () => {
    gm.stratify!.messages = [msg('m2', [att(1, 'one.pdf', 'application/pdf')])];
    expect((await call({ messageId: 'm2' })).attachment.index).toBe(0);
  });
  it('several or no matches give a numbered list as plain text, not an error', async () => {
    for (const args of [{}, { filename: 'two.png' }, { filename: 'missing.pdf' }]) {
      const r = await call({ messageId: 'm1', ...args });
      expect(r.mcpText).toMatch(/^Could not tell which attachment[^\n]*3:\n0\. "one\.pdf" \(application\/pdf, 10 bytes\)\n1\. "two\.png" \(image\/png, 10 bytes\)\n2\. "two\.png" \(text\/csv, 10 bytes\)\n.*attachmentIndex/s);
      expect(r.mcpResource).toBeUndefined();
    }
    expect(gm.stratify!.getAttachment).not.toHaveBeenCalled();
    const res = await respond({ messageId: 'm1' });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
  });
  it('an email without attachments says so; an unknown message says so', async () => {
    gm.stratify!.messages = [msg('m0', [])];
    expect((await call({ messageId: 'm0' })).mcpText).toBe('This email has no attachments.');
    expect((await call({ messageId: 'nope' })).mcpText).toMatch(/No message with that id/);
  });
  it('an inline part without a filename is listed with a placeholder name', async () => {
    gm.stratify!.messages = [msg('m3', [att(1, undefined, 'image/png', 4), att(2, 'x.pdf', 'application/pdf', 4)])];
    expect((await call({ messageId: 'm3' })).mcpText).toContain('0. "(no name)" (image/png, 4 bytes)');
  });
});

describe('what comes back', () => {
  beforeEach(three);

  it('small PDF: the text line, extracted text and a resource block', async () => {
    const r = await call({ messageId: 'm1', attachmentIndex: 0 });
    expect(r.mcpText).toContain(`Downloaded from Gmail by Superconnector: "one.pdf" (application/pdf, ${PDF.length} bytes).`);
    expect(r.mcpText).toContain('FAKE PDF TEXT');
    expect(r.mcpResource).toEqual({ uri: 'gmail-attachment://m1/0', mimeType: 'application/pdf', blob: Buffer.from(PDF).toString('base64') });
    expect(r.account).toBe('stratify');
  });

  it('large PDF (over 3 MB): no extraction at all, the too-big message with saveToDrive', async () => {
    gm.stratify!.bytes.a1 = Buffer.concat([PDF, Buffer.alloc(3_500_000, 0x20)]);
    const r = await call({ messageId: 'm1', attachmentIndex: 0 });
    expect(r.mcpResource).toBeUndefined();
    expect(r.mcpImage).toBeUndefined();
    expect(r.mcpText).not.toMatch(/Extracted text|could not be extracted/);
    expect(r.mcpText).toMatch(/too big to return directly.*saveToDrive: true/s);
    // declared size over 3 MB: not even fetched
    gm.stratify!.messages = [msg('m10', [att(1, 'big.pdf', 'application/pdf', 3_000_001)])];
    vi.mocked(gm.stratify!.getAttachment).mockClear();
    expect((await call({ messageId: 'm10' })).mcpText).toMatch(/too big to return directly/);
    expect(gm.stratify!.getAttachment).not.toHaveBeenCalled();
  });

  it('image: an image block', async () => {
    const r = await call({ messageId: 'm1', attachmentIndex: 1 });
    expect(r.mcpImage).toEqual({ data: Buffer.from([137, 80, 78, 71]).toString('base64'), mimeType: 'image/png' });
    expect(r.mcpResource).toBeUndefined();
    expect(r.mcpText).toBe('Downloaded from Gmail by Superconnector: "two.png" (image/png, 4 bytes).');
  });

  it('CSV: a resource block, and an unusual image type is a resource too', async () => {
    const r = await call({ messageId: 'm1', attachmentIndex: 2 });
    expect(r.mcpResource).toMatchObject({ uri: 'gmail-attachment://m1/2', mimeType: 'text/csv', blob: Buffer.from('a,b\n1,2\n').toString('base64') });
    expect(r.mcpImage).toBeUndefined();
    gm.stratify!.messages = [msg('m4', [att(1, 'v.svg', 'image/svg+xml')])];
    gm.stratify!.bytes.a1 = new TextEncoder().encode('<svg/>');
    expect((await call({ messageId: 'm4' })).mcpResource.mimeType).toBe('image/svg+xml');
  });

  it('a mimeType that is not a plain type/subtype becomes application/octet-stream', async () => {
    gm.stratify!.messages = [msg('m5', [att(1, 'x.bin', 'text/plain\r\nX: y')])];
    gm.stratify!.bytes.a1 = new Uint8Array([1]);
    expect((await call({ messageId: 'm5' })).mcpResource.mimeType).toBe('application/octet-stream');
  });

  it('over 3 MB and not a PDF: a plain message, nothing fetched when the size is declared', async () => {
    gm.stratify!.messages = [msg('m6', [att(1, 'big.zip', 'application/zip', 4_000_000)])];
    const r = await call({ messageId: 'm6' });
    expect(r.mcpText).toMatch(/too big to return directly.*saveToDrive: true/s);
    expect(r.mcpResource).toBeUndefined();
    expect(gm.stratify!.getAttachment).not.toHaveBeenCalled();
    // an undeclared size is caught after the fetch
    gm.stratify!.messages = [msg('m7', [att(1, 'big.zip', 'application/zip')])];
    gm.stratify!.bytes.a1 = new Uint8Array(3_000_001);
    const r2 = await call({ messageId: 'm7' });
    expect(r2.mcpText).toMatch(/too big to return directly/);
    expect(r2.mcpResource).toBeUndefined();
  });

  it('exactly 3 MB is still returned', async () => {
    gm.stratify!.messages = [msg('m8', [att(1, 'edge.bin', 'application/octet-stream', 3_000_000)])];
    gm.stratify!.bytes.a1 = new Uint8Array(3_000_000);
    const res = await respond({ messageId: 'm8' });
    expect(res.content.map((c: { type: string }) => c.type)).toEqual(['text', 'resource']);
    // the whole response stays well under Vercel's ~4.5 MB, and the blob is not in structuredContent
    expect(JSON.stringify(res).length).toBeLessThan(4_200_000);
    expect(JSON.stringify(res.structuredContent)).not.toContain(res.content[1].resource.blob.slice(0, 40));
    expect(res.content[0].text.length).toBeLessThan(500);
  });

  it('structuredContent never holds the blob or image data', async () => {
    for (const idx of [0, 1, 2]) {
      const res = await respond({ messageId: 'm1', attachmentIndex: idx });
      const blobs = res.content.slice(1).map((c: { data?: string; resource?: { blob: string } }) => c.data ?? c.resource!.blob);
      expect(blobs).toHaveLength(1);
      expect(JSON.stringify(res.structuredContent)).not.toContain(blobs[0]);
      expect(Object.keys(res.structuredContent).sort()).toEqual(['account', 'accountEmail', 'attachment']);
    }
  });

  it('refuses over 12 MB, declared or found, with or without saveToDrive', async () => {
    gm.stratify!.messages = [msg('big', [att(1, 'a.bin', 'application/octet-stream', 12_000_001)]), msg('big2', [att(1, 'a.bin', 'application/octet-stream')])];
    gm.stratify!.bytes.a1 = new Uint8Array(12_000_001);
    for (const args of [{ messageId: 'big' }, { messageId: 'big2' }, { messageId: 'big', saveToDrive: true }, { messageId: 'big2', saveToDrive: true }]) {
      const e = await call(args).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GuardrailError);
      expect((e as GuardrailError).message).toMatch(/larger than 12 MB/);
    }
    expect(dr.stratify!.createFile).not.toHaveBeenCalled();
    expect(gm.stratify!.getAttachment).toHaveBeenCalledTimes(2); // only the undeclared one is fetched
    gm.stratify!.messages = [msg('ok12', [att(1, 'a.bin', 'application/octet-stream', 12_000_000)])];
    gm.stratify!.bytes.a1 = new Uint8Array(12_000_000);
    await expect(call({ messageId: 'ok12', saveToDrive: true })).resolves.toMatchObject({ file: { id: 'stratify-file-1' } });
  });
});

describe('saveToDrive', () => {
  beforeEach(() => {
    gm.stratify!.messages = [msg('m1', [att(1, SECRET_NAME, 'application/pdf', 10)])];
    gm.stratify!.bytes = { a1: PDF };
  });

  it('creates the folder once, reuses it, uploads unconverted with the original name and type, returns no bytes', async () => {
    const r = await call({ messageId: 'm1', saveToDrive: true });
    expect(r.file).toEqual({ title: SECRET_NAME, id: 'stratify-file-1', viewUrl: 'https://v/stratify-file-1' });
    expect(r.message).toContain(`Downloaded from Gmail by Superconnector: "${SECRET_NAME}" (application/pdf, ${PDF.length} bytes).`);
    expect(r.mcpResource).toBeUndefined();
    expect(r.mcpImage).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(Buffer.from(PDF).toString('base64'));
    expect(dr.stratify!.searchFiles).toHaveBeenCalledWith(expect.objectContaining({ q: "name = 'Superconnector attachments' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder'" }));
    await call({ messageId: 'm1', saveToDrive: true });
    const creates = (dr.stratify!.createFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(creates.filter((c) => c.mimeType === FOLDER)).toEqual([{ title: 'Superconnector attachments', mimeType: FOLDER, convert: false }]);
    const uploads = creates.filter((c) => c.content);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({ title: SECRET_NAME, parentId: 'stratify-folder', convert: false, content: { contentType: 'application/pdf' } });
    expect(uploads[0].content.bytes).toEqual(PDF);
    expect(dr.stratify!.isSharedFolder).toHaveBeenCalledWith({ folderId: 'stratify-folder' });
  });

  it('audits ids only: no file name, subject or content', async () => {
    await call({ messageId: 'm1', saveToDrive: true });
    expect(audit).toEqual([
      { tool: 'download_gmail_attachment', account: 'stratify', targetId: 'stratify-folder', outcome: 'ok' },
      { tool: 'download_gmail_attachment', account: 'stratify', targetId: 'stratify-file-1', outcome: 'ok' },
    ]);
    const text = JSON.stringify(audit);
    for (const s of [SECRET_NAME, 'Secret', 'subject', 'pdf', 'seb@']) expect(text).not.toContain(s);
  });

  it('a shared folder is refused with the standard refusal, audited, and nothing is uploaded', async () => {
    dr.stratify!.folders = [gFile('shared-1', 'Superconnector attachments', FOLDER)];
    dr.stratify!.shared.add('shared-1');
    const e = await call({ messageId: 'm1', saveToDrive: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GuardrailError);
    expect((e as GuardrailError).rule).toBe('shared_folder');
    expect((e as GuardrailError).message).toMatch(/shared with other people.*Seb does this himself; do not use another connector/s);
    expect(dr.stratify!.createFile).not.toHaveBeenCalled();
    expect(audit).toEqual([{ tool: 'download_gmail_attachment', account: 'stratify', targetId: 'm1', outcome: 'rejected' }]);
  });

  it('works for a non-PDF over 3 MB, which is not returned inline', async () => {
    gm.stratify!.messages = [msg('m9', [att(1, 'big.zip', 'application/zip', 5_000_000)])];
    gm.stratify!.bytes.a1 = new Uint8Array(5_000_000);
    const r = await call({ messageId: 'm9', saveToDrive: true });
    expect(r.file.title).toBe('big.zip');
    expect(r.mcpResource).toBeUndefined();
  });
});

describe('accounts', () => {
  it('finds the message on the account that holds it and saves into that account\'s Drive', async () => {
    gm.prime!.messages = [msg('pm', [att(1, 'p.csv', 'text/csv', 3)])];
    gm.prime!.bytes = { a1: new TextEncoder().encode('a,b') };
    const r = await call({ messageId: 'pm' });
    expect(r).toMatchObject({ account: 'prime', accountEmail: 'seb@prime.test' });
    expect(gm.stratify!.getMessage).toHaveBeenCalled();
    expect(gm.stratify!.getAttachment).not.toHaveBeenCalled();
    const saved = await call({ messageId: 'pm', saveToDrive: true });
    expect(saved).toMatchObject({ account: 'prime', file: { id: 'prime-file-1' } });
    expect(dr.prime!.createFile).toHaveBeenCalled();
    expect(dr.stratify!.createFile).not.toHaveBeenCalled();
    expect(audit.every((a) => a.account === 'prime')).toBe(true);
  });

  it('an explicit account is honoured, and the same id on the other account is not touched', async () => {
    gm.stratify!.messages = [msg('same', [att(1, 's.csv', 'text/csv', 3)])];
    gm.prime!.messages = [msg('same', [att(1, 'p.csv', 'text/csv', 3)])];
    gm.stratify!.bytes = gm.prime!.bytes = { a1: new TextEncoder().encode('abc') };
    expect((await call({ messageId: 'same' })).account).toBe('stratify');
    expect((await call({ messageId: 'same', account: 'prime' })).attachment.filename).toBe('p.csv');
  });
});

describe('logs', () => {
  it('hold no file name, subject or address', async () => {
    gm.stratify!.messages = [msg('m1', [att(1, SECRET_NAME, 'application/pdf', 10)])];
    gm.stratify!.bytes = { a1: PDF };
    await respond({ messageId: 'm1' });
    await respond({ messageId: 'm1', saveToDrive: true });
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    for (const s of [SECRET_NAME, 'Secret', 'seb@']) expect(text).not.toContain(s);
  });
});

describe('registry hooks', () => {
  const kinds = async (extra: object) => {
    const def = { name: 'x', description: 'd', input: z.object({}), kind: 'read', handler: async () => ({ ok: 1, ...extra }) } as unknown as AnyToolDef;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (buildServer(ctx, { defs: [def], baseUrl: 'http://x' }) as any)._registeredTools.x.handler({}, {});
    return res.content.map((c: { type: string }) => c.type);
  };
  const ok = { uri: 'gmail-attachment://m1/0', mimeType: 'text/csv', blob: 'AAAA' };

  it('mcpResource: a good one becomes a resource block and is not in structuredContent', async () => {
    expect(await kinds({ mcpResource: ok })).toEqual(['text', 'resource']);
    const def = { name: 'x', description: 'd', input: z.object({}), kind: 'read', handler: async () => ({ ok: 1, mcpResource: ok }) } as unknown as AnyToolDef;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (buildServer(ctx, { defs: [def], baseUrl: 'http://x' }) as any)._registeredTools.x.handler({}, {});
    expect(res.content[1]).toEqual({ type: 'resource', resource: ok });
    expect(res.structuredContent).toEqual({ ok: 1 });
    expect(res.content[0].text).toBe('{"ok":1}');
  });
  it('mcpResource: a bad uri, mimeType or blob is dropped and the text stays', async () => {
    for (const bad of [
      { uri: 'file:///etc/passwd' }, { uri: 'https://x/0' }, { uri: 'gmail-attachment://m1' }, { uri: 'gmail-attachment://m1/x' }, { uri: 'gmail-attachment://m 1/0' }, { uri: 'gmail-attachment://m1/0\n' },
      { mimeType: 'text' }, { mimeType: 'text/csv; charset=x' }, { mimeType: 'text/csv\r\nX: y' }, { mimeType: '' },
      { blob: 'not base64!' }, { blob: 'AA\nAA' }, { blob: 'A'.repeat(4_000_004) }, { blob: 12 },
    ]) {
      expect(await kinds({ mcpResource: { ...ok, ...bad } })).toEqual(['text']);
    }
    expect(await kinds({ mcpResource: { ...ok, blob: 'A'.repeat(4_000_000) } })).toEqual(['text', 'resource']);
    expect(await kinds({ mcpResource: { ...ok, blob: '' } })).toEqual(['text', 'resource']);
  });
  it('mcpImage: gif and webp are allowed, the cap fits 3 MB, anything else is dropped', async () => {
    for (const mimeType of ['image/gif', 'image/webp', 'image/png', 'image/jpeg']) expect(await kinds({ mcpImage: { data: 'AAAA', mimeType } })).toEqual(['text', 'image']);
    for (const mimeType of ['image/svg+xml', 'image/bmp', 'text/html']) expect(await kinds({ mcpImage: { data: 'AAAA', mimeType } })).toEqual(['text']);
    expect(await kinds({ mcpImage: { data: 'A'.repeat(4_000_000), mimeType: 'image/png' } })).toEqual(['text', 'image']);
    expect(await kinds({ mcpImage: { data: 'A'.repeat(4_000_004), mimeType: 'image/png' } })).toEqual(['text']);
    expect(await kinds({ mcpImage: { data: 'bad data', mimeType: 'image/png' } })).toEqual(['text']);
  });
});
