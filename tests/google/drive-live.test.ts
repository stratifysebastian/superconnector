import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '@/core/contracts/adapter';
import { GuardrailError, ProviderError } from '@/core/errors';
import { ENDPOINT_RULES } from '@/google/endpoints';
import { createGoogleHttp } from '@/google/http';
import { createLiveDriveAdapter } from '@/google/drive';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const q = (u: URL) => Object.fromEntries(u.searchParams);

type Call = { url: URL; method: string; body?: string };
type Handler = (c: Call) => Response | undefined;

function setup(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const c: Call = { url: new URL(url), method: String(init.method), body };
    calls.push(c);
    return handler(c) ?? json({});
  }) as unknown as typeof fetch;
  const http = createGoogleHttp({ getAccessToken: async () => 'tok', fetchImpl, rules: ENDPOINT_RULES, sleep: async () => {} });
  const ctx = { http, account: { email: 'me@x.com' } } as unknown as AdapterContext;
  return { http, adapter: createLiveDriveAdapter(ctx), calls };
}

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'f1', name: 'Doc', mimeType: 'text/plain', fileExtension: 'txt', size: '12', createdTime: 'c', modifiedTime: 'm',
  viewedByMeTime: 'v', modifiedByMeTime: 'mm', sharedWithMeTime: 's', owners: [{ emailAddress: 'o@x.com' }], parents: ['p1', 'p2'],
  capabilities: { canAddChildren: true }, webViewLink: 'https://link', ...over,
});

describe('reads', () => {
  it('maps a Drive resource to GFile and always sends a fields mask', async () => {
    const { adapter, calls } = setup(() => json(raw()));
    expect(await adapter.getFile({ fileId: 'f 1' })).toEqual({
      id: 'f1', title: 'Doc', mimeType: 'text/plain', fileExtension: 'txt', fileSize: '12', createdTime: 'c', modifiedTime: 'm',
      viewedByMeTime: 'v', modifiedByMeTime: 'mm', sharedWithMeTime: 's', owner: 'o@x.com', parentId: 'p1', canAddChildren: true,
      viewUrl: 'https://link', resourceUri: 'googledrive://file/f1',
    });
    expect(calls[0]!.url.pathname).toBe('/drive/v3/files/f%201');
    expect(q(calls[0]!.url).fields).toContain('webViewLink');
  });

  it('uses quotaBytesUsed for native files and null for 404', async () => {
    const native = setup(() => json(raw({ mimeType: 'application/vnd.google-apps.document', size: undefined, quotaBytesUsed: '99' })));
    expect((await native.adapter.getFile({ fileId: 'f1' }))!.fileSize).toBe('99');
    const missing = setup(() => json({}, 404));
    expect(await missing.adapter.getFile({ fileId: 'x' })).toBeNull();
    expect(await missing.adapter.getPermissions({ fileId: 'x' })).toBeNull();
    expect(await missing.adapter.download({ fileId: 'x', maxBytes: 10 })).toBeNull();
  });

  it('searches with trashed excluded and optional modified ordering', async () => {
    const { adapter, calls } = setup(() => json({ files: [raw()], nextPageToken: 'n' }));
    const page = await adapter.searchFiles({ q: "name contains 'a' or starred", pageSize: 5, pageToken: 't', orderByModified: true });
    expect(page.nextPageToken).toBe('n');
    expect(page.items).toHaveLength(1);
    expect(calls[0]!.url.href.startsWith(`${API}/files?`)).toBe(true);
    expect(q(calls[0]!.url)).toMatchObject({
      q: "(name contains 'a' or starred) and trashed = false", pageSize: '5', pageToken: 't', orderBy: 'modifiedTime desc', supportsAllDrives: 'true',
    });
    await adapter.searchFiles({ q: 'x', pageSize: 1, orderByModified: false });
    expect(q(calls[1]!.url).orderBy).toBeUndefined();
  });

  it('maps listRecent orderings', async () => {
    const { adapter, calls } = setup(() => json({}));
    for (const o of ['recency', 'lastModified', 'lastModifiedByMe'] as const) await adapter.listRecent({ orderBy: o, pageSize: 3 });
    expect(calls.map((c) => q(c.url).orderBy)).toEqual(['recency desc', 'modifiedTime desc', 'modifiedByMeTime desc']);
  });

  it('adds a snippet for native files only, cut to snippetChars', async () => {
    const native = setup((c) => (c.url.pathname.endsWith('/export') ? new Response('hello world') : json(raw({ mimeType: 'application/vnd.google-apps.document' }))));
    expect((await native.adapter.getFile({ fileId: 'f1', snippetChars: 5 }))!.contentSnippet).toBe('hello');
    expect(q(native.calls[1]!.url)).toEqual({ mimeType: 'text/plain' });
    const plain = setup(() => json(raw()));
    expect((await plain.adapter.getFile({ fileId: 'f1', snippetChars: 5 }))!.contentSnippet).toBeUndefined();
    expect(plain.calls).toHaveLength(1);
  });

  it('lists permissions across pages', async () => {
    let n = 0;
    const { adapter, calls } = setup(() => json(n++ === 0 ? { permissions: [{ role: 'owner', type: 'user' }], nextPageToken: 'p2' } : { permissions: [{ role: 'reader', type: 'anyone' }] }));
    expect(await adapter.getPermissions({ fileId: 'd1' })).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe('/drive/v3/files/d1/permissions');
    expect(q(calls[1]!.url).pageToken).toBe('p2');
  });
});

describe('download', () => {
  const meta = (over: Record<string, unknown> = {}) => raw({ size: '3', ...over });
  const run = (m: Record<string, unknown>, p: Record<string, unknown> = {}) => {
    const s = setup((c) => (c.url.searchParams.get('fields') ? json(m) : new Response('abc', { headers: { 'content-type': 'x/y' } })));
    return { ...s, out: s.adapter.download({ fileId: 'f1', maxBytes: 1000, ...p }) };
  };

  it('uses alt=media for regular files', async () => {
    const { out, calls } = run(meta());
    const r = (await out)!;
    expect(new TextDecoder().decode(r.bytes)).toBe('abc');
    expect(r).toMatchObject({ mimeType: 'text/plain', title: 'Doc', sourceMimeType: 'text/plain', viewUrl: 'https://link' });
    expect(calls[1]!.url.pathname).toBe('/drive/v3/files/f1');
    expect(q(calls[1]!.url).alt).toBe('media');
  });

  it('uses the revisions endpoint with revisionId', async () => {
    const { out, calls } = run(meta(), { revisionId: 'r9' });
    await out;
    expect(calls[1]!.url.pathname).toBe('/drive/v3/files/f1/revisions/r9');
  });

  it('exports native files with default and explicit types', async () => {
    const doc = run(meta({ mimeType: 'application/vnd.google-apps.document', size: undefined }));
    expect((await doc.out)!.mimeType).toBe('text/plain');
    expect(doc.calls[1]!.url.pathname).toBe('/drive/v3/files/f1/export');
    expect(q(doc.calls[1]!.url)).toEqual({ mimeType: 'text/plain' });
    const sheet = run(meta({ mimeType: 'application/vnd.google-apps.spreadsheet', size: undefined }));
    expect((await sheet.out)!.mimeType).toBe('text/csv');
    const pdf = run(meta({ mimeType: 'application/vnd.google-apps.document', size: undefined }), { exportMimeType: 'application/pdf' });
    expect((await pdf.out)!.mimeType).toBe('application/pdf');
  });

  it('refuses up front when size exceeds maxBytes', async () => {
    const { out, calls } = run(meta({ size: '5000000' }), { maxBytes: 3_000_000 });
    await expect(out).rejects.toThrow('File content is larger than 3 MB, which this server can return');
    await expect(out).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });
});

describe('isSharedFolder', () => {
  const shared = (perms: unknown[]) => setup(() => json({ permissions: perms })).adapter.isSharedFolder({ folderId: 'd1' });
  it('treats root as private without a request', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.isSharedFolder({ folderId: 'root' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('is private with only the owner', async () => expect(await shared([{ role: 'owner', type: 'user', emailAddress: 'me@x.com' }])).toBe(false));
  it('is shared with another user, a domain, anyone, or an unreadable folder', async () => {
    const owner = { role: 'owner', type: 'user', emailAddress: 'me@x.com' };
    expect(await shared([owner, { role: 'reader', type: 'user', emailAddress: 'b@x.com' }])).toBe(true);
    expect(await shared([owner, { role: 'reader', type: 'domain' }])).toBe(true);
    expect(await shared([owner, { role: 'reader', type: 'anyone' }])).toBe(true);
    expect(await shared([{ role: 'writer', type: 'user', emailAddress: 'me@x.com' }])).toBe(true);
    expect(await setup(() => json({}, 404)).adapter.isSharedFolder({ folderId: 'd1' })).toBe(true);
  });
});

describe('writes', () => {
  it('creates with content via multipart, converting when asked', async () => {
    const { adapter, calls } = setup(() => json(raw()));
    await adapter.createFile({ title: 'n', parentId: 'p', content: { bytes: new TextEncoder().encode('a,b'), contentType: 'text/csv' }, convert: true });
    expect(calls[0]!.url.href.startsWith(`${UPLOAD}/files?`)).toBe(true);
    expect(q(calls[0]!.url)).toMatchObject({ uploadType: 'multipart', supportsAllDrives: 'true' });
    expect(calls[0]!.body).toContain('{"name":"n","mimeType":"application/vnd.google-apps.spreadsheet","parents":["p"]}');
    expect(calls[0]!.body).toContain('\r\n\r\na,b\r\n');
    await adapter.createFile({ title: 'n', content: { bytes: new Uint8Array(1), contentType: 'text/csv' }, convert: false });
    expect(calls[1]!.body).toContain('{"name":"n"}');
  });

  it('creates empty native files and folders with json', async () => {
    const { adapter, calls } = setup(() => json(raw()));
    await adapter.createFile({ title: 'F', mimeType: 'application/vnd.google-apps.folder', parentId: 'p', convert: false });
    expect(calls[0]!.url.href.startsWith(`${API}/files?`)).toBe(true);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'F', mimeType: 'application/vnd.google-apps.folder', parents: ['p'] });
  });

  it('copies with name and parent only', async () => {
    const { adapter, calls } = setup(() => json(raw()));
    await adapter.copyFile({ fileId: 'f1', title: 'c', parentId: 'p' });
    expect(calls[0]!.url.pathname).toBe('/drive/v3/files/f1/copy');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'c', parents: ['p'] });
  });

  it('moves by swapping parents and renames', async () => {
    const { adapter, calls } = setup((c) => (c.method === 'GET' ? json({ parents: ['old1', 'old2'] }) : json(raw())));
    await adapter.updateFile({ fileId: 'f1', title: 'T', description: 'D', parentId: 'new' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[1]!.method).toBe('PATCH');
    expect(q(calls[1]!.url)).toMatchObject({ addParents: 'new', removeParents: 'old1,old2' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: 'T', description: 'D' });
  });

  it('does not touch parents without parentId', async () => {
    const { adapter, calls } = setup(() => json(raw()));
    await adapter.updateFile({ fileId: 'f1', title: 'T' });
    expect(calls).toHaveLength(1);
    expect(q(calls[0]!.url).addParents).toBeUndefined();
  });
});

describe('endpoint policy', () => {
  const FILES = `${API}/files`;
  const denied = (p: Promise<unknown>, rule?: string) =>
    expect(p).rejects.toSatisfy((e: unknown) => e instanceof GuardrailError && (rule === undefined || e.message.includes(rule)));

  it('refuses every extra key in update, copy, create and upload bodies', async () => {
    const { http, adapter, calls } = setup();
    const bad = ['writersCanShare', 'copyRequiresWriterPermission', 'trashed', 'permissions', 'owners', 'shared', 'contentRestrictions', 'starred'];
    for (const k of bad) {
      const v = k === 'trashed' ? false : true;
      await denied(http.json({ method: 'PATCH', url: `${FILES}/f1`, body: { name: 'a', [k]: v } }), 'drive.files.update');
      await denied(http.json({ method: 'POST', url: `${FILES}/f1/copy`, body: { name: 'a', [k]: v } }), 'drive.files.copy');
      await denied(http.json({ method: 'POST', url: FILES, body: { name: 'a', mimeType: 'application/vnd.google-apps.folder', [k]: v } }), 'drive.files.create');
      await denied(
        http.upload({ url: `${UPLOAD}/files`, query: { uploadType: 'multipart' }, metadata: { name: 'a', [k]: v }, content: new Uint8Array(1), contentType: 'text/plain' }),
        'drive.files.upload',
      );
    }
    // Parents is not an update key; description is not a copy key; parents must be exactly one id.
    await denied(http.json({ method: 'PATCH', url: `${FILES}/f1`, body: { parents: ['p'] } }), 'drive.files.update');
    await denied(http.json({ method: 'POST', url: `${FILES}/f1/copy`, body: { description: 'd' } }), 'drive.files.copy');
    await denied(http.json({ method: 'POST', url: `${FILES}/f1/copy`, body: { parents: ['a', 'b'] } }), 'drive.files.copy');
    await denied(http.json({ method: 'POST', url: FILES, body: { name: 'a', mimeType: 'text/plain' } }), 'drive.files.create');
    await denied(adapter.createFile({ title: 't', parentId: '', mimeType: 'text/plain', convert: false }).then(() => { throw new GuardrailError('x', 'x'); }));
    expect(calls).toHaveLength(0);
  });

  it('denies permission writes, emptyTrash, trash and delete paths', async () => {
    const { http, calls } = setup();
    await denied(http.json({ method: 'POST', url: `${FILES}/f1/permissions`, body: {} }), 'hard-ban/permissions-write');
    await denied(http.json({ method: 'PATCH', url: `${FILES}/f1/permissions/p1`, body: {} }), 'hard-ban/permissions-write');
    await denied(http.json({ method: 'POST', url: `${FILES}/trash` }), 'hard-ban');
    await denied(http.json({ method: 'POST', url: `${FILES}/f1/trash` }), 'hard-ban');
    await denied(http.json({ method: 'PATCH', url: `${FILES}/f1`, body: { trashed: true } }), 'hard-ban/trashed');
    await denied(http.json({ method: 'GET', url: `${API}/files/f1/watch` }), 'no-matching-rule');
    await denied(http.json({ method: 'POST', url: `${API}/files/f1/watch`, body: {} }), 'no-matching-rule');
    await denied(http.json({ method: 'PATCH', url: `${FILES}/f1`, query: { transferOwnership: true }, body: {} }), 'transfer-ownership');
    await denied(http.json({ method: 'POST', url: `${FILES}/f1/copy`, query: { supportsAllDrives: true, sendNotificationEmail: true }, body: {} }), 'drive.files.copy');
    expect(calls).toHaveLength(0);
  });

  it('enforces transports: json cannot download or upload, download cannot hit json paths', async () => {
    const { http, calls } = setup();
    await denied(http.json({ method: 'GET', url: `${FILES}/f1`, query: { alt: 'media' } }), 'drive.files.get');
    await denied(http.json({ method: 'GET', url: `${FILES}/f1/export`, query: { mimeType: 'text/plain' } }), 'no-matching-rule');
    await denied(http.json({ method: 'POST', url: `${UPLOAD}/files`, query: { uploadType: 'multipart' }, body: { name: 'a' } }), 'no-matching-rule');
    await denied(http.download({ url: FILES, maxBytes: 10 }), 'no-matching-rule');
    await denied(http.download({ url: `${FILES}/f1`, query: { fields: 'id' }, maxBytes: 10 }), 'drive.files.media');
    await denied(http.download({ url: `${FILES}/f1/permissions`, maxBytes: 10 }), 'no-matching-rule');
    await denied(http.upload({ url: `${UPLOAD}/files`, query: { uploadType: 'resumable' }, metadata: { name: 'a' }, content: new Uint8Array(1), contentType: 'text/plain' }));
    expect(calls).toHaveLength(0);
  });
});
