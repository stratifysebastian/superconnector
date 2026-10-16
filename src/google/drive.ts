import type { AdapterContext } from '@/core/contracts/adapter';
import type { DriveAdapter, GFile, RecentOrder } from '@/core/contracts/drive';
import { ProviderError } from '@/core/errors';
import { readPermissions } from './drive/permissions-read';
import { driveUploadUrl, driveUrl } from './endpoints/urls';

interface RawFile {
  id: string;
  name?: string;
  mimeType?: string;
  fileExtension?: string;
  size?: string;
  quotaBytesUsed?: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  modifiedByMeTime?: string;
  sharedWithMeTime?: string;
  owners?: { emailAddress?: string }[];
  parents?: string[];
  capabilities?: { canAddChildren?: boolean };
  webViewLink?: string;
}

const FILE_FIELDS =
  'id,name,mimeType,fileExtension,size,quotaBytesUsed,createdTime,modifiedTime,viewedByMeTime,modifiedByMeTime,sharedWithMeTime,owners(emailAddress),parents,capabilities(canAddChildren),webViewLink';
const NATIVE = 'application/vnd.google-apps.';
const SHEET = `${NATIVE}spreadsheet`;
const enc = encodeURIComponent;
const isNative = (m: string | undefined) => m?.startsWith(NATIVE) === true;
const notFound = (e: unknown) => e instanceof ProviderError && e.kind === 'not_found';

const ORDER: Record<RecentOrder, string> = {
  recency: 'recency desc',
  lastModified: 'modifiedTime desc',
  lastModifiedByMe: 'modifiedByMeTime desc',
};

const CONVERT: Record<string, string> = {
  'text/plain': `${NATIVE}document`,
  'text/html': `${NATIVE}document`,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': `${NATIVE}document`,
  'application/vnd.oasis.opendocument.text': `${NATIVE}document`,
  'application/rtf': `${NATIVE}document`,
  'text/rtf': `${NATIVE}document`,
  'text/csv': SHEET,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': SHEET,
  'application/vnd.oasis.opendocument.spreadsheet': SHEET,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': `${NATIVE}presentation`,
  'application/vnd.oasis.opendocument.presentation': `${NATIVE}presentation`,
};

export function mapFile(r: RawFile): GFile {
  const size = r.size ?? (isNative(r.mimeType) ? r.quotaBytesUsed : undefined);
  const f: GFile = { id: r.id, title: r.name ?? '', mimeType: r.mimeType ?? '', resourceUri: `googledrive://file/${r.id}` };
  const set = <K extends keyof GFile>(k: K, v: GFile[K] | undefined) => {
    if (v !== undefined) f[k] = v;
  };
  set('fileExtension', r.fileExtension);
  set('fileSize', size);
  set('createdTime', r.createdTime);
  set('modifiedTime', r.modifiedTime);
  set('viewedByMeTime', r.viewedByMeTime);
  set('modifiedByMeTime', r.modifiedByMeTime);
  set('sharedWithMeTime', r.sharedWithMeTime);
  set('owner', r.owners?.[0]?.emailAddress);
  set('parentId', r.parents?.[0]);
  set('canAddChildren', r.capabilities?.canAddChildren);
  set('viewUrl', r.webViewLink);
  return f;
}

export function createLiveDriveAdapter(ctx: AdapterContext): DriveAdapter {
  const { http } = ctx;
  const filePath = (id: string) => `/files/${enc(id)}`;

  const list = async (query: Record<string, string | number | boolean | undefined>) => {
    const r = await http.json<{ files?: RawFile[]; nextPageToken?: string }>({
      method: 'GET',
      url: driveUrl('/files'),
      query: { ...query, fields: `nextPageToken,files(${FILE_FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true },
    });
    return { items: (r.files ?? []).map(mapFile), nextPageToken: r.nextPageToken };
  };

  const getRaw = async (id: string, fields: string): Promise<RawFile | null> => {
    try {
      return await http.json<RawFile>({ method: 'GET', url: driveUrl(filePath(id)), query: { fields, supportsAllDrives: true } });
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  };

  const exportText = (id: string, mimeType: string, maxBytes: number) =>
    http.download({ url: driveUrl(`${filePath(id)}/export`), query: { mimeType }, maxBytes });

  return {
    searchFiles: (p) =>
      list({ q: `(${p.q}) and trashed = false`, pageSize: p.pageSize, pageToken: p.pageToken, orderBy: p.orderByModified ? 'modifiedTime desc' : undefined }),

    listRecent: (p) => list({ q: 'trashed = false', orderBy: ORDER[p.orderBy], pageSize: p.pageSize, pageToken: p.pageToken }),

    async getFile(p) {
      const raw = await getRaw(p.fileId, FILE_FIELDS);
      if (!raw) return null;
      const f = mapFile(raw);
      if (p.snippetChars && isNative(raw.mimeType)) {
        try {
          const { bytes } = await exportText(p.fileId, 'text/plain', 200_000);
          f.contentSnippet = new TextDecoder().decode(bytes).slice(0, p.snippetChars);
        } catch (e) {
          // shortcut: the snippet is optional, so a too-large or unexportable doc just has none; upgrade if snippets must be guaranteed.
          if (!(e instanceof ProviderError)) throw e;
        }
      }
      return f;
    },

    getPermissions: (p) => readPermissions(http, p.fileId),

    async download(p) {
      const meta = await getRaw(p.fileId, 'id,name,mimeType,size,webViewLink');
      if (!meta) return null;
      if (meta.size !== undefined && Number(meta.size) > p.maxBytes) {
        throw new ProviderError('upstream_error', `File content is larger than ${Math.floor(p.maxBytes / 1_000_000)} MB, which this server can return`);
      }
      const sourceMimeType = meta.mimeType ?? 'application/octet-stream';
      let mimeType = sourceMimeType;
      try {
        let r: { bytes: Uint8Array; contentType: string };
        if (isNative(sourceMimeType)) {
          mimeType = p.exportMimeType ?? (sourceMimeType === SHEET ? 'text/csv' : 'text/plain');
          r = await exportText(p.fileId, mimeType, p.maxBytes);
        } else {
          const path = p.revisionId ? `${filePath(p.fileId)}/revisions/${enc(p.revisionId)}` : filePath(p.fileId);
          r = await http.download({ url: driveUrl(path), query: { alt: 'media', supportsAllDrives: true }, maxBytes: p.maxBytes });
        }
        return { bytes: r.bytes, mimeType, title: meta.name ?? '', sourceMimeType, ...(meta.webViewLink ? { viewUrl: meta.webViewLink } : {}) };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },

    async isSharedFolder(p) {
      if (p.folderId === 'root') return false;
      const perms = await readPermissions(http, p.folderId);
      // Fail closed: a folder we cannot read the permissions of counts as shared. Any grant beyond the single owner
      // (another user, group, domain or anyone-with-link) makes it shared.
      return perms === null || perms.some((x) => x.role !== 'owner' || x.type !== 'user');
    },

    async createFile(p) {
      const query = { fields: FILE_FIELDS, supportsAllDrives: true };
      const parents = p.parentId ? [p.parentId] : undefined;
      let raw: RawFile;
      if (p.content || !p.mimeType) {
        const content = p.content ?? { bytes: new Uint8Array(0), contentType: 'text/plain' };
        const target = p.convert ? CONVERT[content.contentType] : undefined;
        raw = await http.upload<RawFile>({
          url: driveUploadUrl('/files'),
          query: { ...query, uploadType: 'multipart' },
          metadata: { name: p.title, ...(target ? { mimeType: target } : {}), ...(parents ? { parents } : {}) },
          content: content.bytes,
          contentType: content.contentType,
        });
      } else {
        raw = await http.json<RawFile>({
          method: 'POST',
          url: driveUrl('/files'),
          query,
          body: { name: p.title, mimeType: p.mimeType, ...(parents ? { parents } : {}) },
        });
      }
      return mapFile(raw);
    },

    async copyFile(p) {
      const body = { ...(p.title !== undefined ? { name: p.title } : {}), ...(p.parentId ? { parents: [p.parentId] } : {}) };
      return mapFile(
        await http.json<RawFile>({ method: 'POST', url: driveUrl(`${filePath(p.fileId)}/copy`), query: { fields: FILE_FIELDS, supportsAllDrives: true }, body }),
      );
    },

    async updateFile(p) {
      let add: string | undefined;
      let remove: string | undefined;
      if (p.parentId) {
        const cur = await getRaw(p.fileId, 'parents');
        if (!cur) throw new ProviderError('not_found', 'Google resource not found', 404);
        const old = (cur.parents ?? []).filter((x) => x !== p.parentId);
        if (!cur.parents?.includes(p.parentId)) add = p.parentId;
        if (old.length) remove = old.join(',');
      }
      const body = { ...(p.title !== undefined ? { name: p.title } : {}), ...(p.description !== undefined ? { description: p.description } : {}) };
      return mapFile(
        await http.json<RawFile>({
          method: 'PATCH',
          url: driveUrl(filePath(p.fileId)),
          query: { fields: FILE_FIELDS, supportsAllDrives: true, addParents: add, removeParents: remove },
          body,
        }),
      );
    },
  };
}
