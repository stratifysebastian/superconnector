import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { DriveAdapter, GFile } from '@/core/contracts/drive';
import type { ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { GuardrailError, ProviderError } from '@/core/errors';
import { z } from 'zod';
import { getToolDefs, buildServer, type AnyToolDef } from '@/mcp/registry';
import { translateQuery } from '@/mcp/tools/drive/query';
import { assertNoExcludedTools } from '../contract/excluded';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';

const acct = (label: string, priority: number): Account => ({
  id: `id-${label}`, provider: 'google', email: `seb@${label}.test`, label, orgClientId: 'org', priority,
  connectedAt: '2026-01-01T00:00:00Z', status: 'active', grantedScopes: [],
});
const accounts = [acct('stratify', 0), acct('prime', 1)];
const T = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

const file = (id: string, extra: Partial<GFile> = {}): GFile => ({
  id, title: `Secret name ${id}`, mimeType: 'application/vnd.google-apps.document', modifiedTime: T(1), resourceUri: `googledrive://file/${id}`, viewUrl: `https://v/${id}`, ...extra,
});

interface Fake extends DriveAdapter { files: GFile[]; shared: Set<string>; bytes: Uint8Array; dlMime: string }
let fakes: Record<string, Fake>;
let audit: { tool: string; account: string; targetId?: string; outcome: string }[];
let ctx: ToolContext;

function makeFake(): Fake {
  const f = {
    files: [], shared: new Set<string>(), bytes: new TextEncoder().encode('hello'), dlMime: 'text/plain',
    searchFiles: vi.fn(async (p) => {
      const s = Number(p.pageToken ?? 0);
      return { items: f.files.slice(s, s + p.pageSize), ...(s + p.pageSize < f.files.length ? { nextPageToken: String(s + p.pageSize) } : {}) };
    }),
    listRecent: vi.fn(async (p) => {
      const s = Number(p.pageToken ?? 0);
      return { items: f.files.slice(s, s + p.pageSize), ...(s + p.pageSize < f.files.length ? { nextPageToken: String(s + p.pageSize) } : {}) };
    }),
    getFile: vi.fn(async (p) => f.files.find((x) => x.id === p.fileId) ?? null),
    getPermissions: vi.fn(async (p) => (f.files.some((x) => x.id === p.fileId) ? [{ role: 'owner', type: 'user' }] : null)),
    download: vi.fn(async (p) => {
      const x = f.files.find((y) => y.id === p.fileId);
      return x ? { bytes: f.bytes, mimeType: f.dlMime, title: x.title, sourceMimeType: x.mimeType } : null;
    }),
    isSharedFolder: vi.fn(async (p) => f.shared.has(p.folderId)),
    createFile: vi.fn(async (p) => file('new-1', { title: p.title })),
    copyFile: vi.fn(async () => file('copy-1')),
    updateFile: vi.fn(async (p) => file(p.fileId)),
  } as unknown as Fake;
  return f;
}

beforeEach(() => {
  fakes = { stratify: makeFake(), prime: makeFake() };
  audit = [];
  ctx = {
    store: { accounts: { list: async () => accounts }, audit: { write: async (e: (typeof audit)[number]) => void audit.push(e) } },
    fanout: createFanOutEngine({ listAccounts: async () => accounts, cursorSecret: 's'.repeat(32), reconnectUrl: '/connect' }),
    adapters: { drive: (c: { account: Account }) => fakes[c.account.label]! },
    adapterContext: (account: Account) => ({ account }),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ToolContext;
});

const tool = (name: string): AnyToolDef => getToolDefs('http://x').find((d) => d.name === name)!;
const call = (name: string, args: Record<string, unknown> = {}) => {
  const def = tool(name);
  return def.handler(def.input.parse(args) as never, ctx) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const WRITES = ['createFile', 'copyFile', 'updateFile'] as const;
const writeCalls = () => Object.values(fakes).flatMap((f) => WRITES.flatMap((m) => (f[m] as ReturnType<typeof vi.fn>).mock.calls));

describe('registry', () => {
  it('registers exactly the enabled names (29 existing + 9 Drive + send_self_report + 21 QuickBooks = 60) and no share or trash tool', () => {
    const names = getToolDefs('http://x').map((d) => d.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(names).toHaveLength(60);
    expect(names.filter((n) => /share|trash|delete/.test(n))).toEqual([]);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
  });
});

describe('query translator', () => {
  const q = (s: string) => translateQuery(s).q;
  it('translates valid queries', () => {
    expect(q('')).toBe('trashed = false');
    expect(q("title contains 'hello'")).toBe("name contains 'hello' and trashed = false");
    expect(q("title = 'a' and title != 'b'")).toBe("(name = 'a' and name != 'b') and trashed = false");
    expect(q("parentId = 'x'")).toBe("'x' in parents and trashed = false");
    expect(q("parentId != 'x'")).toBe("(not 'x' in parents) and trashed = false");
    expect(q("owner = 'me'")).toBe("'me' in owners and trashed = false");
    expect(q('sharedWithMe = true')).toBe('sharedWithMe and trashed = false');
    expect(q('sharedWithMe != true')).toBe('(not sharedWithMe) and trashed = false');
    expect(q('starred = true')).toBe('starred = true and trashed = false');
    expect(q("modifiedTime > '2024-01-01T00:00:00Z' and (mimeType contains 'image/' or mimeType contains 'video/')")).toBe(
      "(modifiedTime > '2024-01-01T00:00:00Z' and (mimeType contains 'image/' or mimeType contains 'video/')) and trashed = false",
    );
    expect(q("not (title = 'a' or starred = false)")).toBe("(not (name = 'a' or starred = false)) and trashed = false");
  });
  it('detects fullText', () => {
    expect(translateQuery("fullText contains 'x'").hasFullText).toBe(true);
    expect(translateQuery("title contains 'x'").hasFullText).toBe(false);
  });
  it('re-escapes quotes and backslashes', () => {
    expect(q("title contains 'it\\'s'")).toBe("name contains 'it\\'s' and trashed = false");
    expect(q("title contains 'a\\\\'")).toBe("name contains 'a\\\\' and trashed = false");
    expect(q("title contains ' or trashed = true or name contains '")).toBe("name contains ' or trashed = true or name contains ' and trashed = false");
  });
  it.each([
    ["unknown term", "trashed = true", 'trashed'],
    ["raw drive syntax", "'x' in parents", "'x'"],
    ["injection via or", "title contains 'a' or trashed = true", 'trashed'],
    ["injection via unescaped quote", "title contains 'a' or name contains 'b", 'unterminated'],
    ["bad operator", "fullText = 'a'", 'fullText'],
    ["bad bool", "starred = 'yes'", 'true or false'],
    ["bad time", "modifiedTime > 'yesterday'", 'RFC 3339'],
    ["name term", "name contains 'a'", 'name'],
    ["missing paren", "(title = 'a'", 'parenthesis'],
    ["trailing junk", "title = 'a' )", ')'],
    ["bad char", "title = 'a'; drop", ';'],
  ])('refuses %s', (_n, query, token) => {
    expect(() => translateQuery(query)).toThrow(GuardrailError);
    expect(() => translateQuery(query)).toThrow(token);
  });
});

describe('search_files', () => {
  it('sends the translated q and uses modifiedTime ordering with a cursor round trip', async () => {
    fakes.stratify!.files = [file('s1', { modifiedTime: T(10) }), file('s2', { modifiedTime: T(6) }), file('s3', { modifiedTime: T(2) })];
    fakes.prime!.files = [file('p1', { modifiedTime: T(8) }), file('p2', { modifiedTime: T(4) })];
    const first = await call('search_files', { query: "title contains 'a'", pageSize: 2 });
    expect(first.files.map((f: GFile) => f.id)).toEqual(['s1', 'p1']);
    expect(fakes.stratify!.searchFiles).toHaveBeenCalledWith(expect.objectContaining({ q: "name contains 'a' and trashed = false", orderByModified: true }));
    const second = await call('search_files', { query: "title contains 'a'", pageSize: 2, pageToken: first.nextCursor });
    expect(second.files.map((f: GFile) => f.id)).toEqual(['s2', 'p2']);
    const third = await call('search_files', { query: "title contains 'a'", pageSize: 2, pageToken: second.nextCursor });
    expect(third.files.map((f: GFile) => f.id)).toEqual(['s3']);
    expect(third.nextCursor).toBeUndefined();
    expect(third.accountErrors).toEqual([]);
  });

  it('lists fullText results account by account and keeps paging exact', async () => {
    fakes.stratify!.files = [file('s1', { modifiedTime: T(1) }), file('s2', { modifiedTime: T(2) })];
    fakes.prime!.files = [file('p1', { modifiedTime: T(30) })];
    const q = { query: "fullText contains 'x'", pageSize: 2 };
    const first = await call('search_files', q);
    expect(first.files.map((f: GFile) => f.id)).toEqual(['s1', 's2']);
    expect(fakes.stratify!.searchFiles).toHaveBeenCalledWith(expect.objectContaining({ orderByModified: false }));
    const second = await call('search_files', { ...q, pageToken: first.nextCursor });
    expect(second.files.map((f: GFile) => f.id)).toEqual(['p1']);
  });

  it('refuses a bad query before any adapter call', async () => {
    await expect(call('search_files', { query: "title contains 'a' or trashed = true" })).rejects.toThrow(GuardrailError);
    expect(fakes.stratify!.searchFiles).not.toHaveBeenCalled();
  });

  it('de-duplicates a file seen by both accounts', async () => {
    fakes.stratify!.files = [file('shared', { modifiedTime: T(5) })];
    fakes.prime!.files = [file('shared', { modifiedTime: T(5) }), file('only-p', { modifiedTime: T(3) })];
    const r = await call('search_files', {});
    expect(r.files.map((f: GFile) => f.id)).toEqual(['shared', 'only-p']);
    expect(r.files[0]).toMatchObject({ account: 'stratify', accounts: ['stratify', 'prime'], sources: [{ account: 'stratify', id: 'shared' }, { account: 'prime', id: 'shared' }] });
  });
});

describe('list_recent_files', () => {
  it('orders by the max of the recency fields, strips extra fields and falls back for unknown orderBy', async () => {
    fakes.stratify!.files = [file('s1', { modifiedTime: T(2), viewedByMeTime: T(9), modifiedByMeTime: T(3), sharedWithMeTime: T(4) })];
    fakes.prime!.files = [file('p1', { modifiedTime: T(5), sharedWithMeTime: T(7) })];
    const r = await call('list_recent_files', { orderBy: 'bogus' });
    expect(r.files.map((f: GFile) => f.id)).toEqual(['s1', 'p1']);
    expect(r.files[0]).not.toHaveProperty('modifiedByMeTime');
    expect(r.files[0]).not.toHaveProperty('sharedWithMeTime');
    expect(fakes.stratify!.listRecent).toHaveBeenCalledWith(expect.objectContaining({ orderBy: 'recency', pageSize: 10 }));
  });
  it('lastModifiedByMe merges on modifiedByMeTime (missing = 0)', async () => {
    fakes.stratify!.files = [file('s1', { modifiedTime: T(20), modifiedByMeTime: T(2) })];
    fakes.prime!.files = [file('p1', { modifiedTime: T(1), modifiedByMeTime: T(6) }), file('p0', { modifiedTime: T(30) })];
    // prime's own order is by modifiedByMe desc in reality; the fake lists p1 then p0 (p0 has none => 0)
    fakes.prime!.files = [fakes.prime!.files[0]!, { ...fakes.prime!.files[1]!, modifiedByMeTime: undefined }];
    const r = await call('list_recent_files', { orderBy: 'lastModifiedByMe' });
    expect(r.files.map((f: GFile) => f.id)).toEqual(['p1', 's1', 'p0']);
  });
  it('de-dups by id', async () => {
    fakes.stratify!.files = [file('x')];
    fakes.prime!.files = [file('x')];
    expect((await call('list_recent_files')).files).toHaveLength(1);
  });
});

describe('get_file_metadata', () => {
  it.each([
    [{}, 5000], [{ snippetVerbosity: 'UNSPECIFIED' }, 5000], [{ snippetVerbosity: 'BRIEF' }, 1000], [{ snippetVerbosity: 'MEDIUM' }, 2500],
    [{ snippetVerbosity: 'DETAILED' }, 5000], [{ snippetVerbosity: 'MAX_ALLOWED' }, 20000], [{ excludeContentSnippets: true, snippetVerbosity: 'BRIEF' }, undefined],
  ])('snippet args %j -> %s', async (args, chars) => {
    fakes.prime!.files = [file('f1')];
    const r = await call('get_file_metadata', { fileId: 'f1', ...args });
    expect(r).toMatchObject({ id: 'f1', account: 'prime' });
    const arg = (fakes.prime!.getFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.snippetChars).toBe(chars);
  });
  it('reports a missing file plainly', async () => {
    expect((await call('get_file_metadata', { fileId: 'nope' })).message).toMatch(/No file/);
  });
  it('get_file_permissions returns permissions', async () => {
    fakes.stratify!.files = [file('f1')];
    expect(await call('get_file_permissions', { fileId: 'f1' })).toMatchObject({ permissions: [{ role: 'owner' }], account: 'stratify' });
  });
});

function minimalPdf(text: string, pages = 1): Uint8Array {
  const stream = `BT /F1 18 Tf 20 50 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 6} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('read_file_content', () => {
  it('reads a native doc as text and a native sheet as CSV', async () => {
    fakes.stratify!.files = [file('d1'), file('sh1', { mimeType: 'application/vnd.google-apps.spreadsheet' })];
    expect(await call('read_file_content', { fileId: 'd1' })).toMatchObject({ fileContent: 'hello', title: 'Secret name d1', viewUrl: 'https://v/d1', account: 'stratify' });
    await call('read_file_content', { fileId: 'sh1' });
    const dl = (fakes.stratify!.download as ReturnType<typeof vi.fn>).mock.calls;
    expect(dl[0]![0].exportMimeType).toBe('text/plain');
    expect(dl[1]![0].exportMimeType).toBe('text/csv');
    expect(dl[0]![0].maxBytes).toBe(1_500_000);
  });
  it('extracts PDF text', async () => {
    fakes.stratify!.files = [file('pdf1', { mimeType: 'application/pdf' })];
    fakes.stratify!.bytes = minimalPdf('Hello PDF world');
    const r = await call('read_file_content', { fileId: 'pdf1' });
    expect(r.fileContent).toContain('Hello PDF world');
  });
  it('returns image content through the MCP server and keeps JSON text without the bytes', async () => {
    fakes.stratify!.files = [file('img1', { mimeType: 'image/png' })];
    fakes.stratify!.bytes = new Uint8Array([137, 80, 78, 71]);
    const r = await call('read_file_content', { fileId: 'img1' });
    expect(r.mcpImage).toEqual({ data: Buffer.from([137, 80, 78, 71]).toString('base64'), mimeType: 'image/png' });
    const server = buildServer(ctx, { defs: [tool('read_file_content')], baseUrl: 'http://x' }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await server._registeredTools.read_file_content.handler({ fileId: 'img1' }, {});
    expect(res.content.map((c: { type: string }) => c.type)).toEqual(['text', 'image']);
    expect(res.content[0].text).not.toContain('mcpImage');
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });
  it('points Office files to download_file_content without downloading', async () => {
    fakes.stratify!.files = [file('w1', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })];
    const r = await call('read_file_content', { fileId: 'w1' });
    expect(r.fileContent).toMatch(/download_file_content/);
    expect(fakes.stratify!.download).not.toHaveBeenCalled();
  });
});

describe('download_file_content', () => {
  it('returns base64 with id, mimeType and title', async () => {
    fakes.stratify!.files = [file('f1')];
    expect(await call('download_file_content', { fileId: 'f1' })).toMatchObject({ content: Buffer.from('hello').toString('base64'), id: 'f1', mimeType: 'text/plain', title: 'Secret name f1' });
    expect((fakes.stratify!.download as ReturnType<typeof vi.fn>).mock.calls[0]![0].maxBytes).toBe(1_500_000);
  });
  it('keeps the over-cap error clear', async () => {
    fakes.stratify!.files = [file('big')];
    (fakes.stratify!.download as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError('upstream_error', 'File content is larger than 1.5 MB, which this server can return'));
    const r = await call('download_file_content', { fileId: 'big' });
    expect(r.message).toMatch(/could not be read/);
    expect(r.accountErrors[0].message).toMatch(/larger than 1.5 MB/);
  });
});

describe('F1 to F7 regressions', () => {
  it.each(['create_file', 'copy_file', 'update_file'])('%s refuses parentId "" at schema level', (name) => {
    expect(() => tool(name).input.parse({ title: 't', fileId: 'f1', parentId: '', account: 'stratify' })).toThrow();
  });
  it('copy of a file whose original sits in a shared folder is refused, with or without the empty-string trick', async () => {
    fakes.stratify!.files = [file('f1', { parentId: 'SHARED' })];
    fakes.stratify!.shared.add('SHARED');
    await expect(call('copy_file', { fileId: 'f1' })).rejects.toThrow(/shared with other people/);
    expect(writeCalls()).toHaveLength(0);
  });
  it('copy sends the checked folder (the original\'s parent) explicitly', async () => {
    fakes.stratify!.files = [file('f1', { parentId: 'mine' })];
    await call('copy_file', { fileId: 'f1' });
    expect(fakes.stratify!.copyFile).toHaveBeenCalledWith({ fileId: 'f1', parentId: 'mine' });
  });
  it('write account inference refuses to fall to a lower-priority hit when an account errored', async () => {
    fakes.prime!.files = [file('f1', { parentId: 'ok' })];
    (fakes.stratify!.getFile as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError('rate_limited', 'slow down'));
    await expect(call('copy_file', { fileId: 'f1' })).rejects.toThrow(/Which one: stratify or prime\?/);
    await expect(call('update_file', { fileId: 'f1', title: 'x' })).rejects.toThrow(/Which one/);
    expect(writeCalls()).toHaveLength(0);
  });
  it('refuses a 101-page PDF and a PDF over 1 MB', async () => {
    fakes.stratify!.files = [file('pdf1', { mimeType: 'application/pdf' })];
    fakes.stratify!.bytes = minimalPdf('x', 101);
    expect((await call('read_file_content', { fileId: 'pdf1' })).fileContent).toMatch(/101 pages/);
    fakes.stratify!.bytes = new Uint8Array(1_000_001);
    expect((await call('read_file_content', { fileId: 'pdf1' })).fileContent).toMatch(/larger than 1 MB.*download_file_content/);
  });
  it('registry drops an invalid mcpImage but keeps the text result', async () => {
    const run = async (mcpImage: unknown) => {
      const def = { name: 'img', description: 'd', input: z.object({}), kind: 'read', handler: async () => ({ ok: 1, mcpImage }) } as unknown as AnyToolDef;
      const server = buildServer(ctx, { defs: [def], baseUrl: 'http://x' }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      return (await server._registeredTools.img.handler({}, {})).content.map((c: { type: string }) => c.type);
    };
    expect(await run({ data: 'AAAA', mimeType: 'image/png' })).toEqual(['text', 'image']);
    expect(await run({ data: 'AAAA', mimeType: 'image/svg+xml' })).toEqual(['text']);
    expect(await run({ data: 'not base64!', mimeType: 'image/png' })).toEqual(['text']);
    expect(await run({ data: 'A'.repeat(2_000_004), mimeType: 'image/jpeg' })).toEqual(['text']);
  });
  it('refuses a deeply nested not chain cleanly and an over-long query', () => {
    expect(() => translateQuery(`${'not '.repeat(200000)}title = 'a'`)).toThrow(GuardrailError);
    expect(() => tool('search_files').input.parse({ query: 'x'.repeat(2001) })).toThrow();
  });
  it('create_file with a non-native mimeType and no content is refused before any adapter call', async () => {
    await expect(call('create_file', { title: 't', account: 'stratify', mimeType: 'text/plain' })).rejects.toThrow(/Google type/);
    expect(writeCalls()).toHaveLength(0);
  });
});

describe('create_file', () => {
  it('needs an account', async () => {
    await expect(call('create_file', { title: 't', textContent: 'x' })).rejects.toThrow(/Writes need exactly one account/);
    expect(writeCalls()).toHaveLength(0);
  });
  it.each([
    [{ textContent: 'a', base64Content: 'YQ==', contentMimeType: 'text/plain' }, /not both/],
    [{ textContent: 'a', content: 'YQ==', contentMimeType: 'text/plain' }, /not both/],
    [{ base64Content: 'YQ==' }, /contentMimeType is required/],
    [{ content: 'YQ==' }, /contentMimeType is required/],
    [{ textContent: 'x'.repeat(3_000_001) }, /3 MB/],
    [{ base64Content: Buffer.alloc(3_000_001).toString('base64'), contentMimeType: 'application/pdf' }, /3 MB/],
  ])('validates %#', async (args, msg) => {
    await expect(call('create_file', { title: 't', account: 'stratify', ...args })).rejects.toThrow(msg);
    expect(writeCalls()).toHaveLength(0);
  });
  it('creates from text, base64 alias and deprecated mimeType, with convert default', async () => {
    const r = await call('create_file', { title: 't', account: 'stratify', textContent: 'hi' });
    expect(r).toMatchObject({ id: 'new-1', account: 'stratify' });
    const a1 = (fakes.stratify!.createFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(a1).toMatchObject({ convert: true, content: { contentType: 'text/plain' } });
    await call('create_file', { title: 't', account: 'stratify', content: 'YQ==', mimeType: 'text/csv', disableConversionToGoogleType: true });
    const a2 = (fakes.stratify!.createFile as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(a2).toMatchObject({ convert: false, content: { contentType: 'text/csv' } });
    expect(Buffer.from(a2.content.bytes).toString()).toBe('a');
  });
  it('allows My Drive root without a check', async () => {
    await call('create_file', { title: 't', account: 'stratify', parentId: 'root', textContent: 'x' });
    expect(fakes.stratify!.isSharedFolder).not.toHaveBeenCalled();
  });
  it('refuses a shared folder with no write and an audit entry', async () => {
    fakes.stratify!.shared.add('F');
    await expect(call('create_file', { title: 'Secret title', account: 'stratify', parentId: 'F', textContent: 'secret body' })).rejects.toThrow(/shared with other people.*Seb can move it there himself.*never shares, trashes or deletes/);
    expect(writeCalls()).toHaveLength(0);
    expect(audit).toEqual([{ tool: 'create_file', account: 'stratify', targetId: undefined, outcome: 'rejected' }]);
  });
});

describe('copy_file and update_file', () => {
  it('copy refuses an explicit shared destination', async () => {
    fakes.stratify!.files = [file('f1', { parentId: 'mine' })];
    fakes.stratify!.shared.add('F');
    await expect(call('copy_file', { fileId: 'f1', parentId: 'F' })).rejects.toThrow(GuardrailError);
    expect(writeCalls()).toHaveLength(0);
    expect(audit).toEqual([{ tool: 'copy_file', account: 'stratify', targetId: 'f1', outcome: 'rejected' }]);
  });
  it('copy refuses an implicit destination in a shared folder', async () => {
    fakes.prime!.files = [file('f1', { parentId: 'SF' })];
    fakes.prime!.shared.add('SF');
    await expect(call('copy_file', { fileId: 'f1', title: 'x' })).rejects.toThrow(/shared with other people/);
    expect(writeCalls()).toHaveLength(0);
  });
  it('copy works to an unshared folder, defaulting the account to the one that sees the file', async () => {
    fakes.prime!.files = [file('f1', { parentId: 'ok' })];
    const r = await call('copy_file', { fileId: 'f1', title: 'Copy' });
    expect(r).toMatchObject({ id: 'copy-1', account: 'prime' });
    expect(fakes.prime!.copyFile).toHaveBeenCalledWith({ fileId: 'f1', title: 'Copy', parentId: 'ok' });
    expect(audit).toEqual([{ tool: 'copy_file', account: 'prime', targetId: 'copy-1', outcome: 'ok' }]);
  });
  it('update refuses a move into a shared folder but allows a rename of a file already in one', async () => {
    fakes.stratify!.files = [file('f1', { parentId: 'SF' })];
    fakes.stratify!.shared.add('SF');
    fakes.stratify!.shared.add('F');
    await expect(call('update_file', { fileId: 'f1', parentId: 'F' })).rejects.toThrow(/shared with other people/);
    expect(writeCalls()).toHaveLength(0);
    await call('update_file', { fileId: 'f1', title: 'New', description: 'd' });
    expect(fakes.stratify!.updateFile).toHaveBeenCalledWith({ fileId: 'f1', title: 'New', description: 'd' });
  });
  it('update needs a change', async () => {
    fakes.stratify!.files = [file('f1')];
    await expect(call('update_file', { fileId: 'f1' })).rejects.toThrow(/at least one/);
  });
  it('audit entries hold only tool, account, target id and outcome', async () => {
    fakes.stratify!.files = [file('f1')];
    await call('update_file', { fileId: 'f1', title: 'Secret new title', description: 'secret description' });
    await call('create_file', { title: 'Secret title', account: 'stratify', textContent: 'secret body' });
    expect(audit.map((e) => Object.keys(e).sort())).toEqual([['account', 'outcome', 'targetId', 'tool'], ['account', 'outcome', 'targetId', 'tool']]);
    expect(JSON.stringify(audit)).not.toMatch(/secret/i);
  });
});
