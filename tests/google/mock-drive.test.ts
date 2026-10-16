import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Account } from '@/core/contracts/account';
import type { AdapterContext } from '@/core/contracts/adapter';
import type { DriveAdapter, GFile } from '@/core/contracts/drive';
import { ProviderError } from '@/core/errors';
import { createMockDriveAdapter, resetMockDrive } from '@/google/mock/drive';
import { resetMockFaults, setMockFaults } from '@/google/mock/faults';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  resetMockFaults();
  resetMockDrive();
});

function adapter(label: 'stratify' | 'prime', signal: AbortSignal = new AbortController().signal): DriveAdapter {
  const account = { label, email: `seb@${label}.example` } as Account;
  return createMockDriveAdapter({ account, signal } as unknown as AdapterContext);
}

const search = async (a: DriveAdapter, q: string, orderByModified = false): Promise<GFile[]> =>
  (await a.searchFiles({ q, pageSize: 100, orderByModified })).items;
const titles = (fs: GFile[]): string[] => fs.map((f) => f.title);

describe('mock drive q evaluator', () => {
  it('handles name, fullText, mimeType', async () => {
    const a = adapter('stratify');
    expect(titles(await search(a, "name = 'Budget'"))).toEqual(['Budget']);
    expect(await search(a, "name contains 'budget'")).toHaveLength(1);
    expect((await search(a, "name != 'Budget' and mimeType = 'application/vnd.google-apps.spreadsheet'")).length).toBeGreaterThan(1);
    expect(titles(await search(a, "fullText contains 'diary'"))).toEqual(['Private diary']);
    expect(await search(a, "mimeType contains 'pdf'")).toHaveLength(1);
    expect(await search(a, "mimeType != 'application/vnd.google-apps.folder'")).toHaveLength(23);
  });

  it('handles parents, owners, sharedWithMe, starred, trashed', async () => {
    const a = adapter('prime');
    expect(titles(await search(a, "'p-fld-private' in parents"))).toEqual(['Private diary']);
    expect(titles(await search(a, "'seb@stratify.example' in owners"))).toEqual(['Shared roadmap']);
    expect(titles(await search(a, 'sharedWithMe'))).toEqual(['Shared roadmap']);
    expect(titles(await search(a, 'sharedWithMe = true'))).toEqual(['Shared roadmap']);
    expect(titles(await search(a, 'starred = true'))).toEqual(['Budget']);
    expect(await search(a, 'trashed = false')).toHaveLength(26);
    expect(await search(a, 'trashed = true')).toHaveLength(0);
  });

  it('compares times and combines and/or/not with parentheses', async () => {
    const a = adapter('stratify');
    expect((await search(a, "modifiedTime > '2026-10-15T00:00:00Z'")).length).toBe(3);
    expect(await search(a, "modifiedTime < '2026-10-02T00:00:00Z' and createdTime > '2000-01-01T00:00:00Z'")).not.toHaveLength(0);
    expect(await search(a, "viewedByMeTime >= '2026-10-16T12:00:00Z'")).toHaveLength(1);
    expect(titles(await search(a, "(name = 'Budget' or name = 'Logo.png') and not name = 'Logo.png'"))).toEqual(['Budget']);
    expect(titles(await search(a, "name = 'Budget' or name = 'Logo.png'")).sort()).toEqual(['Budget', 'Logo.png']);
  });

  it('refuses anything outside the grammar', async () => {
    const a = adapter('stratify');
    for (const q of ["foo = 'x'", "name contains", "name ~ 'x'", "(name = 'x'", "name = 'x' garbage", "writers contains 'x'"])
      await expect(search(a, q)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('mock drive ordering and paging', () => {
  it('orderByModified sorts desc; otherwise fixture order', async () => {
    const a = adapter('stratify');
    const sorted = await search(a, 'trashed = false', true);
    const ts = sorted.map((f) => f.modifiedTime!);
    expect(ts).toEqual([...ts].sort().reverse());
    const plain = await search(a, 'trashed = false');
    expect(plain[0]!.title).toBe('Projects');
    expect(titles(plain)).not.toEqual(titles(sorted));
  });

  it('pages with offset tokens without repeats', async () => {
    const a = adapter('stratify');
    const seen: string[] = [];
    let pageToken: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await a.searchFiles({ q: 'trashed = false', pageSize: 10, orderByModified: true, ...(pageToken ? { pageToken } : {}) });
      sizes.push(page.items.length);
      seen.push(...page.items.map((f) => f.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    expect(sizes).toEqual([10, 10, 6]);
    expect(new Set(seen).size).toBe(26);
  });

  it('listRecent orders by the requested key', async () => {
    const a = adapter('prime');
    const rec = (await a.listRecent({ orderBy: 'recency', pageSize: 100 })).items;
    expect(rec).toHaveLength(26);
    const mod = (await a.listRecent({ orderBy: 'lastModified', pageSize: 100 })).items.map((f) => f.modifiedTime!);
    expect(mod).toEqual([...mod].sort().reverse());
    const mine = (await a.listRecent({ orderBy: 'lastModifiedByMe', pageSize: 100 })).items;
    expect(mine.some((f) => f.owner !== 'seb@prime.example')).toBe(false);
    const p1 = await a.listRecent({ orderBy: 'recency', pageSize: 20 });
    expect(p1.nextPageToken).toBe('20');
  });
});

describe('mock drive reads', () => {
  it('shows the shared file on both accounts with the same id', async () => {
    const s = await adapter('stratify').getFile({ fileId: 'shared-roadmap-doc' });
    const p = await adapter('prime').getFile({ fileId: 'shared-roadmap-doc' });
    expect(s?.owner).toBe('seb@stratify.example');
    expect(p?.owner).toBe('seb@stratify.example');
    expect(p?.sharedWithMeTime).toBeTruthy();
    expect(await adapter('prime').getFile({ fileId: 'pdf-nope' })).toBeNull();
    expect(await adapter('prime').getFile({ fileId: 's-fld-private' })).toBeNull();
    expect((await adapter('prime').getPermissions({ fileId: 'shared-roadmap-doc' }))?.map((x) => x.role)).toEqual(['owner', 'writer']);
    expect(await adapter('prime').getPermissions({ fileId: 's-fld-private' })).toBeNull();
  });

  it('gives snippets only to native files when asked', async () => {
    const a = adapter('stratify');
    expect((await a.getFile({ fileId: 's-doc-notes', snippetChars: 10 }))?.contentSnippet).toBe('FAKE meeti');
    expect((await a.getFile({ fileId: 's-doc-notes' }))?.contentSnippet).toBeUndefined();
    expect((await a.getFile({ fileId: 's-pdf-fake', snippetChars: 10 }))?.contentSnippet).toBeUndefined();
  });

  it('isSharedFolder', async () => {
    const a = adapter('stratify');
    expect(await a.isSharedFolder({ folderId: 'root' })).toBe(false);
    expect(await a.isSharedFolder({ folderId: 's-fld-shared' })).toBe(true);
    expect(await a.isSharedFolder({ folderId: 's-fld-private' })).toBe(false);
    expect(await a.isSharedFolder({ folderId: 'no-such-folder' })).toBe(true);
    expect((await a.getPermissions({ fileId: 's-fld-shared' }))?.some((x) => x.emailAddress === 'someone@outside.example')).toBe(true);
  });
});

describe('mock drive download', () => {
  const dec = new TextDecoder();
  it('exports native files as text, sheets as csv, or PDF', async () => {
    const a = adapter('stratify');
    const doc = await a.download({ fileId: 's-doc-notes', maxBytes: 1e6 });
    expect(doc?.mimeType).toBe('text/plain');
    expect(dec.decode(doc!.bytes)).toContain('FAKE meeting notes');
    const sheet = await a.download({ fileId: 's-sheet-budget', maxBytes: 1e6 });
    expect(sheet?.mimeType).toBe('text/csv');
    expect(dec.decode(sheet!.bytes)).toContain('rent,1000');
    const pdf = await a.download({ fileId: 's-doc-notes', exportMimeType: 'application/pdf', maxBytes: 1e6 });
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.sourceMimeType).toBe('application/vnd.google-apps.document');
    expect(await a.download({ fileId: 'nope', maxBytes: 10 })).toBeNull();
  });

  it('returns binary bytes; the PDF text extracts with unpdf', async () => {
    const a = adapter('stratify');
    const png = await a.download({ fileId: 's-png-fake', maxBytes: 1e6 });
    expect(png?.mimeType).toBe('image/png');
    expect(Array.from(png!.bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    const pdf = await a.download({ fileId: 's-pdf-fake', maxBytes: 1e6 });
    const doc = await getDocumentProxy(new Uint8Array(pdf!.bytes));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toContain('FAKE PDF TEXT');
  });

  it('throws when over maxBytes', async () => {
    const a = adapter('stratify');
    await expect(a.download({ fileId: 's-pdf-fake', maxBytes: 20 })).rejects.toThrow(/File content is larger than/);
    await expect(a.download({ fileId: 's-doc-notes', maxBytes: 5 })).rejects.toMatchObject({ kind: 'upstream_error' });
  });
});

describe('mock drive writes', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('createFile converts text/plain and text/csv when asked', async () => {
    const a = adapter('stratify');
    const doc = await a.createFile({ title: 'n', content: { bytes: enc('hello'), contentType: 'text/plain' }, convert: true });
    expect(doc.mimeType).toBe('application/vnd.google-apps.document');
    expect(doc.parentId).toBe('root');
    expect((await a.download({ fileId: doc.id, maxBytes: 100 }))?.mimeType).toBe('text/plain');
    const sheet = await a.createFile({ title: 's', content: { bytes: enc('a,b'), contentType: 'text/csv' }, convert: true });
    expect(sheet.mimeType).toBe('application/vnd.google-apps.spreadsheet');
    const raw = await a.createFile({ title: 'r.txt', content: { bytes: enc('raw'), contentType: 'text/plain' }, convert: false });
    expect(raw.mimeType).toBe('text/plain');
    expect(dec((await a.download({ fileId: raw.id, maxBytes: 100 }))?.bytes)).toBe('raw');
    const pngLike = await a.createFile({ title: 'x.png', content: { bytes: enc('x'), contentType: 'image/png' }, convert: true });
    expect(pngLike.mimeType).toBe('image/png');
    const folder = await a.createFile({ title: 'F', mimeType: 'application/vnd.google-apps.folder', convert: false, parentId: 's-fld-projects' });
    expect(folder.canAddChildren).toBe(true);
    expect(await a.isSharedFolder({ folderId: folder.id })).toBe(false);
    expect(await adapter('prime').getFile({ fileId: doc.id })).toBeNull();
  });

  it('copyFile and updateFile', async () => {
    const a = adapter('stratify');
    const copy = await a.copyFile({ fileId: 's-doc-notes' });
    expect(copy.title).toBe('Copy of Meeting notes');
    expect(copy.id).not.toBe('s-doc-notes');
    expect(copy.parentId).toBe('s-fld-projects');
    const named = await a.copyFile({ fileId: 's-doc-notes', title: 'Mine', parentId: 's-fld-private' });
    expect([named.title, named.parentId]).toEqual(['Mine', 's-fld-private']);
    const up = await a.updateFile({ fileId: copy.id, title: 'Renamed', description: 'd', parentId: 's-fld-private' });
    expect([up.title, up.parentId]).toEqual(['Renamed', 's-fld-private']);
    expect(titles(await search(a, "name = 'Renamed' and 's-fld-private' in parents"))).toEqual(['Renamed']);
    await expect(a.updateFile({ fileId: 'nope', title: 'x' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.copyFile({ fileId: 'nope' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reset restores the fixtures', async () => {
    const a = adapter('stratify');
    await a.updateFile({ fileId: 's-doc-notes', title: 'Changed' });
    expect((await a.getFile({ fileId: 's-doc-notes' }))?.title).toBe('Changed');
    resetMockDrive();
    expect((await adapter('stratify').getFile({ fileId: 's-doc-notes' }))?.title).toBe('Meeting notes');
  });
});

const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b ?? new Uint8Array());

describe('mock drive faults', () => {
  it('invalid_grant and rate_limited reject; other accounts are unaffected', async () => {
    setMockFaults({ stratify: 'invalid_grant', prime: 'rate_limited' });
    await expect(adapter('stratify').getFile({ fileId: 'x' })).rejects.toMatchObject({ kind: 'needs_reconnect' });
    await expect(adapter('prime').listRecent({ orderBy: 'recency', pageSize: 5 })).rejects.toMatchObject({ kind: 'rate_limited' });
    setMockFaults({ prime: 'invalid_grant' });
    expect(await adapter('stratify').getFile({ fileId: 's-doc-notes' })).not.toBeNull();
  });

  it('timeout hangs until the signal aborts', async () => {
    setMockFaults({ stratify: 'timeout' });
    const ac = new AbortController();
    const p = adapter('stratify', ac.signal).searchFiles({ q: 'trashed = false', pageSize: 5, orderByModified: true });
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });
});
