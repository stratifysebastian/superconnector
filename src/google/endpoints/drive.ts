import { PERMISSIONS_LIST_PATH } from '../drive/permissions-read';
import type { EndpointRule, Transport } from './policy';

const HOST = 'www.googleapis.com';
const ID = String.raw`[^/]+`;
const NATIVE = 'application/vnd.google-apps.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): string | null => {
  const bad = Object.keys(o).find((k) => !keys.includes(k));
  return bad ? `field "${bad}" is not allowed` : null;
};
const oneParent = (v: unknown): string | null =>
  Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && v[0] !== '' ? null : 'parents must be an array of exactly one folder id';
const optString = (o: Record<string, unknown>, k: string): string | null =>
  o[k] === undefined || (typeof o[k] === 'string' && o[k] !== '') ? null : `${k} must be a non-empty string`;

/** name / mimeType / parents only; `native` requires a Google-native mimeType (empty file or folder). */
const checkCreate = (native: boolean) => (body: unknown): string | null => {
  if (!isObj(body)) return 'body must be a JSON object';
  const bad = onlyKeys(body, ['name', 'mimeType', 'parents']);
  if (bad) return bad;
  const m = body.mimeType;
  if (native && !(typeof m === 'string' && m.startsWith(NATIVE))) return `mimeType must start with ${NATIVE}`;
  return optString(body, 'name') ?? optString(body, 'mimeType') ?? (body.parents === undefined ? null : oneParent(body.parents));
};

function checkCopy(body: unknown): string | null {
  if (!isObj(body)) return 'body must be a JSON object';
  return onlyKeys(body, ['name', 'parents']) ?? optString(body, 'name') ?? (body.parents === undefined ? null : oneParent(body.parents));
}

function checkPatch(body: unknown): string | null {
  if (!isObj(body)) return 'body must be a JSON object';
  const bad = onlyKeys(body, ['name', 'description']);
  if (bad) return bad;
  if (body.description !== undefined && typeof body.description !== 'string') return 'description must be a string';
  return optString(body, 'name');
}

const rule = (
  id: string,
  method: EndpointRule['method'],
  path: RegExp,
  allowedQuery: string[],
  extra: { requiredQuery?: Record<string, string>; checkBody?: EndpointRule['checkBody']; transport?: Transport } = {},
): EndpointRule => ({ id: `drive.${id}`, product: 'drive', method, host: HOST, path, allowedQuery, ...extra });

const F = String.raw`^/drive/v3/files`;
const media = { requiredQuery: { alt: 'media' }, transport: 'download' as const };

export const DRIVE_RULES: EndpointRule[] = [
  rule('files.list', 'GET', new RegExp(`${F}$`), ['q', 'pageSize', 'pageToken', 'orderBy', 'fields', 'corpora', 'includeItemsFromAllDrives', 'supportsAllDrives', 'spaces']),
  rule('files.get', 'GET', new RegExp(`${F}/${ID}$`), ['fields', 'supportsAllDrives']),
  rule('files.media', 'GET', new RegExp(`${F}/${ID}$`), ['supportsAllDrives'], media),
  rule('files.export', 'GET', new RegExp(`${F}/${ID}/export$`), ['mimeType'], { transport: 'download' }),
  rule('revisions.media', 'GET', new RegExp(`${F}/${ID}/revisions/${ID}$`), ['supportsAllDrives'], media),
  rule('permissions.list', 'GET', PERMISSIONS_LIST_PATH, ['fields', 'pageSize', 'pageToken', 'supportsAllDrives']),
  rule('files.upload', 'POST', /^\/upload\/drive\/v3\/files$/, ['fields'], {
    requiredQuery: { uploadType: 'multipart' }, checkBody: checkCreate(false), transport: 'upload',
  }),
  rule('files.create', 'POST', new RegExp(`${F}$`), ['fields'], { checkBody: checkCreate(true) }),
  rule('files.copy', 'POST', new RegExp(`${F}/${ID}/copy$`), ['fields'], { checkBody: checkCopy }),
  rule('files.update', 'PATCH', new RegExp(`${F}/${ID}$`), ['addParents', 'removeParents', 'fields'], { checkBody: checkPatch }),
];
