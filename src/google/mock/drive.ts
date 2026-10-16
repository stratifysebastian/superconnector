import type { AdapterContext } from '@/core/contracts/adapter';
import type { Page } from '@/core/contracts/calendar';
import type { DriveAdapter, GFile, GPermission } from '@/core/contracts/drive';
import { ProviderError } from '@/core/errors';
import { loadFixture } from './fixtures';
import { withMockFaults } from './faults';

const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const FOLDER = 'application/vnd.google-apps.folder';
const isNative = (mt: string): boolean => mt.startsWith('application/vnd.google-apps.');

/** Stored file: GFile fields plus mock-only content. Native files keep `text`; others keep `contentBase64`. */
interface Stored {
  id: string;
  title: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  viewedByMeTime?: string;
  modifiedByMeTime?: string;
  sharedWithMeTime?: string;
  owner?: string;
  parentId?: string;
  description?: string;
  starred?: boolean;
  trashed?: boolean;
  text?: string;
  contentBase64?: string;
}
interface State {
  files: Stored[];
  perms: Record<string, GPermission[]>;
  counter: number;
}

const states = new Map<string, State>();

export function resetMockDrive(): void {
  states.clear();
}

function stateFor(label: string): State {
  let s = states.get(label);
  if (!s) {
    s = {
      files: structuredClone(loadFixture<{ files: Stored[] }>('drive', label, 'files').files),
      perms: structuredClone(loadFixture<{ permissions: Record<string, GPermission[]> }>('drive', label, 'permissions').permissions),
      counter: 0,
    };
    states.set(label, s);
  }
  return s;
}

const bytesOf = (f: Stored): Uint8Array =>
  f.contentBase64 !== undefined ? new Uint8Array(Buffer.from(f.contentBase64, 'base64')) : new TextEncoder().encode(f.text ?? '');

function toGFile(f: Stored, snippetChars?: number): GFile {
  const native = isNative(f.mimeType);
  const ext = !native && f.title.includes('.') ? f.title.split('.').pop() : undefined;
  return {
    id: f.id,
    title: f.title,
    mimeType: f.mimeType,
    ...(ext ? { fileExtension: ext } : {}),
    fileSize: String(bytesOf(f).length),
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    ...(f.viewedByMeTime ? { viewedByMeTime: f.viewedByMeTime } : {}),
    ...(f.modifiedByMeTime ? { modifiedByMeTime: f.modifiedByMeTime } : {}),
    ...(f.sharedWithMeTime ? { sharedWithMeTime: f.sharedWithMeTime } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.parentId ? { parentId: f.parentId } : {}),
    canAddChildren: f.mimeType === FOLDER,
    viewUrl: f.mimeType === FOLDER ? `https://drive.google.com/drive/folders/${f.id}` : `https://drive.google.com/file/d/${f.id}/view`,
    resourceUri: `googledrive://file/${f.id}`,
    ...(snippetChars && native && f.mimeType !== FOLDER ? { contentSnippet: (f.text ?? '').slice(0, snippetChars) } : {}),
  };
}

// ---- Drive v3 `q` evaluator (subset) ----
type Tok = { t: 'str' | 'word' | 'op' | 'lp' | 'rp'; v: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '(' || c === ')') {
      out.push({ t: c === '(' ? 'lp' : 'rp', v: c });
      i++;
    } else if (c === "'") {
      let v = '';
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === '\\') i++;
        v += q[i++] ?? '';
      }
      if (q[i] !== "'") throw new ProviderError('upstream_error', 'Invalid query: unterminated string', 400);
      i++;
      out.push({ t: 'str', v });
    } else {
      const m = /^(!=|<=|>=|=|<|>)|^[A-Za-z_][A-Za-z0-9_]*/.exec(q.slice(i));
      if (!m) throw new ProviderError('upstream_error', 'Invalid query: unexpected character', 400);
      out.push({ t: m[1] ? 'op' : 'word', v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

function compile(q: string, email: string): (f: Stored) => boolean {
  const toks = tokenize(q);
  let pos = 0;
  const bad = (): never => {
    throw new ProviderError('upstream_error', 'Invalid query', 400);
  };
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => toks[pos++] ?? bad();
  const isWord = (w: string): boolean => peek()?.t === 'word' && peek()!.v === w;

  const orExpr = (): ((f: Stored) => boolean) => {
    let l = andExpr();
    while (isWord('or')) {
      pos++;
      const a = l;
      const b = andExpr();
      l = (f) => a(f) || b(f);
    }
    return l;
  };
  const andExpr = (): ((f: Stored) => boolean) => {
    let l = notExpr();
    while (isWord('and')) {
      pos++;
      const a = l;
      const b = notExpr();
      l = (f) => a(f) && b(f);
    }
    return l;
  };
  const notExpr = (): ((f: Stored) => boolean) => {
    if (isWord('not')) {
      pos++;
      const a = notExpr();
      return (f) => !a(f);
    }
    if (peek()?.t === 'lp') {
      pos++;
      const e = orExpr();
      if (next().t !== 'rp') bad();
      return e;
    }
    return cond();
  };
  const lower = (s: string | undefined): string => (s ?? '').toLowerCase();
  const time = (s: string | undefined): number => (s ? Date.parse(s) : Number.NaN);
  const cmp = (op: string, a: number, b: number): boolean =>
    op === '=' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;

  const cond = (): ((f: Stored) => boolean) => {
    const first = next();
    if (first.t === 'str') {
      if (next().v !== 'in') bad();
      const field = next().v;
      if (field === 'parents') return (f) => f.parentId === first.v;
      if (field === 'owners') return (f) => (first.v === 'me' ? f.owner === email : lower(f.owner) === lower(first.v));
      return bad();
    }
    if (first.t !== 'word') return bad();
    const field = first.v;
    if (field === 'sharedWithMe' || field === 'starred' || field === 'trashed') {
      let want = true;
      if (peek()?.t === 'op') {
        const op = next().v;
        want = next().v === 'true';
        if (op === '!=') want = !want;
        else if (op !== '=') bad();
      }
      const get = (f: Stored): boolean =>
        field === 'sharedWithMe' ? !!f.sharedWithMeTime : field === 'starred' ? !!f.starred : !!f.trashed;
      return (f) => get(f) === want;
    }
    const opTok = next();
    const op = opTok.v;
    const valTok = next();
    if (valTok.t !== 'str') return bad();
    const v = valTok.v;
    if (op === 'contains') {
      if (field === 'name') return (f) => lower(f.title).includes(lower(v));
      if (field === 'fullText') return (f) => lower(f.title).includes(lower(v)) || lower(f.text).includes(lower(v));
      if (field === 'mimeType') return (f) => lower(f.mimeType).includes(lower(v));
      return bad();
    }
    if (field === 'name' || field === 'mimeType') {
      if (op !== '=' && op !== '!=') return bad();
      const get = (f: Stored): string => (field === 'name' ? f.title : f.mimeType);
      return (f) => (get(f) === v) === (op === '=');
    }
    if (field === 'modifiedTime' || field === 'createdTime' || field === 'viewedByMeTime') {
      const t = time(v);
      if (Number.isNaN(t)) bad();
      return (f) => {
        const a = time(f[field]);
        return !Number.isNaN(a) && cmp(op, a, t);
      };
    }
    return bad();
  };

  const root = orExpr();
  if (pos < toks.length) bad();
  return root;
}

/** pageToken is the string offset. */
function paginate<T>(all: T[], pageSize: number, pageToken?: string): Page<T> {
  const offset = pageToken ? Number.parseInt(pageToken, 10) || 0 : 0;
  const items = all.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  return next < all.length ? { items, nextPageToken: String(next) } : { items };
}

const ms = (s: string | undefined): number => (s ? Date.parse(s) : 0);
const recency = (f: Stored): number => Math.max(ms(f.createdTime), ms(f.modifiedTime), ms(f.viewedByMeTime), ms(f.sharedWithMeTime));

export function createMockDriveAdapter(ctx: AdapterContext): DriveAdapter {
  const { label, email } = ctx.account;
  const s = (): State => stateFor(label);
  const run = <T>(fn: () => T): Promise<T> => withMockFaults(ctx.account, fn, { signal: ctx.signal });
  const find = (id: string): Stored | undefined => s().files.find((f) => f.id === id && !f.trashed);
  const must = (id: string): Stored => find(id) ?? ((): never => { throw new ProviderError('not_found', 'File not found', 404); })();
  const now = (): string => new Date().toISOString().replace('.000', '');
  const add = (f: Omit<Stored, 'id' | 'createdTime' | 'modifiedTime' | 'owner'>): Stored => {
    const st = s();
    const t = now();
    const out: Stored = { ...f, id: `mock-${label}-${++st.counter}`, createdTime: t, modifiedTime: t, modifiedByMeTime: t, owner: email };
    st.files.push(out);
    st.perms[out.id] = [{ displayName: label, emailAddress: email, role: 'owner', type: 'user' }];
    return out;
  };

  return {
    searchFiles: (p) =>
      run(() => {
        const test = compile(p.q, email);
        const hits = s().files.filter((f) => !f.trashed && test(f));
        if (p.orderByModified) hits.sort((a, b) => ms(b.modifiedTime) - ms(a.modifiedTime));
        const page = paginate(hits, p.pageSize, p.pageToken);
        return { ...page, items: page.items.map((f) => toGFile(f)) };
      }),

    listRecent: (p) =>
      run(() => {
        const key = (f: Stored): number =>
          p.orderBy === 'recency'
            ? recency(f)
            : p.orderBy === 'lastModified'
              ? ms(f.modifiedTime)
              : ms(f.modifiedByMeTime) || (f.owner === email ? ms(f.modifiedTime) : 0);
        const all = s()
          .files.filter((f) => !f.trashed && key(f) > 0)
          .sort((a, b) => key(b) - key(a));
        const page = paginate(all, p.pageSize, p.pageToken);
        return { ...page, items: page.items.map((f) => toGFile(f)) };
      }),

    getFile: ({ fileId, snippetChars }) =>
      run(() => {
        const f = find(fileId);
        return f ? toGFile(f, snippetChars) : null;
      }),

    getPermissions: ({ fileId }) =>
      run(() => (find(fileId) ? structuredClone(s().perms[fileId] ?? []) : null)),

    download: ({ fileId, exportMimeType, maxBytes }) =>
      run(() => {
        const f = find(fileId);
        if (!f) return null;
        let bytes: Uint8Array;
        let mimeType: string;
        if (!isNative(f.mimeType)) {
          bytes = bytesOf(f);
          mimeType = f.mimeType;
        } else if (exportMimeType === 'application/pdf') {
          const pdf = s().files.find((x) => x.mimeType === 'application/pdf');
          if (!pdf) throw new ProviderError('upstream_error', 'Export is not available', 400);
          bytes = bytesOf(pdf);
          mimeType = 'application/pdf';
        } else {
          mimeType = exportMimeType ?? (f.mimeType === SHEET ? 'text/csv' : 'text/plain');
          bytes = new TextEncoder().encode(f.text ?? '');
        }
        if (bytes.length > maxBytes) throw new ProviderError('upstream_error', `File content is larger than ${maxBytes} bytes`);
        const toolView = toGFile(f);
        return { bytes, mimeType, title: f.title, sourceMimeType: f.mimeType, ...(toolView.viewUrl ? { viewUrl: toolView.viewUrl } : {}) };
      }),

    isSharedFolder: ({ folderId }) =>
      run(() => {
        if (folderId === 'root') return false;
        const f = find(folderId);
        if (!f) return false;
        return (s().perms[folderId] ?? []).some((x) => x.role !== 'owner');
      }),

    createFile: (p) =>
      run(() => {
        let mimeType = p.mimeType ?? 'text/plain';
        let text: string | undefined;
        let contentBase64: string | undefined;
        if (p.content) {
          const ct = p.content.contentType;
          const google = p.convert ? (ct === 'text/plain' ? DOC : ct === 'text/csv' ? SHEET : undefined) : undefined;
          if (google) {
            mimeType = google;
            text = new TextDecoder().decode(p.content.bytes);
          } else {
            mimeType = ct;
            contentBase64 = Buffer.from(p.content.bytes).toString('base64');
          }
        } else if (isNative(mimeType)) text = '';
        else contentBase64 = '';
        return toGFile(add({ title: p.title, mimeType, parentId: p.parentId ?? 'root', ...(text !== undefined ? { text } : {}), ...(contentBase64 !== undefined ? { contentBase64 } : {}) }));
      }),

    copyFile: (p) =>
      run(() => {
        const src = must(p.fileId);
        const { id: _id, createdTime: _c, modifiedTime: _m, owner: _o, sharedWithMeTime: _s, viewedByMeTime: _v, ...rest } = src;
        return toGFile(add({ ...rest, title: p.title ?? `Copy of ${src.title}`, parentId: p.parentId ?? src.parentId ?? 'root' }));
      }),

    updateFile: (p) =>
      run(() => {
        const f = must(p.fileId);
        if (p.title !== undefined) f.title = p.title;
        if (p.description !== undefined) f.description = p.description;
        if (p.parentId !== undefined) f.parentId = p.parentId;
        f.modifiedTime = f.modifiedByMeTime = now();
        return toGFile(f);
      }),
  };
}
