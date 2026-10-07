import { describe, expect, it } from 'vitest';
import { ALLOWLIST, BANNED_PATTERNS, EXCLUDED_TOOL_NAMES, assertNoExcludedTools } from './excluded';
import { formatViolations, scanSources } from './scan';

const P = 'src/google/test-adapter.ts'; // an ordinary adapter path (no allowlist entries)
const PERM = 'src/google/drive/permissions-read.ts'; // the allowlisted read-only permissions file

interface Seed {
  name: string;
  id: string;
  code: string;
  file?: string;
}

const VIOLATIONS: Seed[] = [
  { name: 'rules injected into createGoogleHttp', id: 'rules-injection', code: 'const http = createGoogleHttp({ getAccessToken, rules: MY_RULES });' },
  { name: 'rules shorthand injected', id: 'rules-injection', code: 'createGoogleHttp({\n  getAccessToken: async () => t,\n  rules,\n});' },
  // Gmail
  { name: 'plain messages/send', id: 'gmail-send', code: "await http.post('/gmail/v1/users/me/messages/send', body);" },
  { name: 'template literal messages/send', id: 'gmail-send', code: 'const url = `${base}/messages/send`;' },
  { name: 'split concatenation messages/send', id: 'gmail-send', code: "const u = base + '/messages/' + 'send';" },
  { name: 'multi-line concatenation', id: 'gmail-send', code: "const u = '/gmail/v1/users/me/messages/' +\n  'send';" },
  { name: 'literal-in-template', id: 'gmail-send', code: 'const u = `/gmail/v1/users/me/messages/${"send"}`;' },
  { name: 'concat() split', id: 'gmail-send', code: "const u = '/messages/'.concat('send');" },
  { name: 'drafts/send', id: 'gmail-send', code: "http.post('/gmail/v1/users/me/drafts/send', { id });" },
  { name: 'upload path send', id: 'gmail-send', code: "const U = '/upload/gmail/v1/users/me/messages/send?uploadType=media';" },
  { name: 'messages trash', id: 'gmail-trash', code: 'http.post(`/gmail/v1/users/me/messages/${id}/trash`);' },
  { name: 'messages untrash', id: 'gmail-trash', code: "http.post('/gmail/v1/users/me/messages/' + id + '/untrash');" },
  { name: 'threads trash', id: 'gmail-trash', code: 'http.post(`/gmail/v1/users/me/threads/${tid}/trash`);' },
  { name: 'TRASH label via modify', id: 'gmail-trash-label', code: "http.post(url, { addLabelIds: ['TRASH'] });" },
  { name: 'batchDelete', id: 'gmail-batch-delete', code: "http.post('/gmail/v1/users/me/messages/batchDelete', { ids });" },
  { name: 'messages/import', id: 'gmail-import-insert', code: "http.post('/gmail/v1/users/me/messages/import', raw);" },
  { name: 'messages/insert', id: 'gmail-import-insert', code: 'http.post(`${B}/messages/insert`, raw);' },
  { name: 'settings/filters', id: 'gmail-filters', code: "http.post('/gmail/v1/users/me/settings/filters', f);" },
  { name: 'forwardingAddresses', id: 'gmail-forwarding', code: "http.get('/gmail/v1/users/me/settings/forwardingAddresses');" },
  { name: 'autoForwarding', id: 'gmail-forwarding', code: "http.put('/gmail/v1/users/me/settings/autoForwarding', s);" },
  { name: 'settings/sendAs', id: 'gmail-sendas', code: "http.get('/gmail/v1/users/me/settings/sendAs');" },
  { name: 'settings/delegates', id: 'gmail-delegates', code: "http.get('/gmail/v1/users/me/settings/delegates');" },

  // Calendar
  { name: "sendUpdates: 'all'", id: 'cal-send-updates', code: "const q = { sendUpdates: 'all' };" },
  { name: 'sendUpdates: "externalOnly"', id: 'cal-send-updates', code: 'const q = { sendUpdates: "externalOnly" };' },
  { name: 'sendUpdates in URL query', id: 'cal-send-updates', code: 'const u = `${B}/events?sendUpdates=all`;' },
  { name: 'sendUpdates from variable', id: 'cal-send-updates', code: 'const q = { sendUpdates: mode };' },
  { name: 'sendUpdates shorthand', id: 'cal-send-updates', code: 'const q = { sendUpdates, conferenceDataVersion: 0 };' },
  { name: 'sendUpdates value on next line', id: 'cal-send-updates', code: "const q = {\n  sendUpdates:\n    'all',\n};" },
  { name: 'sendUpdates via URLSearchParams', id: 'cal-send-updates', code: "params.set('sendUpdates', 'all');" },
  { name: 'sendUpdates assigned by bracket', id: 'cal-send-updates', code: "query['sendUpdates'] = 'externalOnly';" },
  { name: 'sendNotifications true', id: 'cal-send-notifications', code: 'const q = { sendNotifications: true };' },
  { name: 'sendNotifications in query', id: 'cal-send-notifications', code: 'const u = `${B}?sendNotifications=true`;' },
  { name: '/acl endpoint', id: 'cal-acl', code: 'http.post(`/calendar/v3/calendars/${c}/acl`, rule);' },
  { name: 'quickAdd', id: 'cal-quickadd', code: "http.post(`/calendar/v3/calendars/primary/events/quickAdd?text=${t}`);" },
  { name: 'responseStatus assignment', id: 'cal-rsvp', code: "const body = { responseStatus: 'accepted' };" },
  { name: 'responseStatus quoted key', id: 'cal-rsvp', code: 'const body = { "responseStatus": "declined" };' },
  { name: 'responseStatus property assignment', id: 'cal-rsvp', code: "attendee.responseStatus = 'tentative';" },
  { name: 'attendees: [{email}]', id: 'cal-attendees-write', code: "const body = { summary, attendees: [{ email: 'a@b.co' }] };" },
  { name: 'quoted attendees key', id: 'cal-attendees-write', code: 'const body = { "attendees": [] };' },
  { name: 'attendees from variable', id: 'cal-attendees-write', code: 'const body = { attendees: input.attendees };' },
  { name: 'addedAttendees', id: 'cal-attendees-write', code: 'const body = { addedAttendees: list };' },
  { name: 'attendeeEmails', id: 'cal-attendees-write', code: "const body = { attendeeEmails: ['a@b.co'] };" },
  { name: 'guestPermissions', id: 'cal-attendees-write', code: 'const body = { guestPermissions: p };' },

  // Drive
  { name: 'permissions POST', id: 'drive-permissions', code: 'await http.post(`/drive/v3/files/${id}/permissions`, { role: "reader", type: "anyone" });' },
  { name: 'permissions DELETE-ish path', id: 'drive-permissions', code: "const u = '/drive/v3/files/' + id + '/permissions/' + pid;" },
  { name: 'permissions GET outside allowlisted file', id: 'drive-permissions', code: 'await http.get(`/drive/v3/files/${id}/permissions`);' },
  { name: 'permissions-read file doing a POST', id: 'drive-permissions-nonget', file: PERM, code: 'await http.post(`/drive/v3/files/${id}/permissions`, body);' },
  { name: 'permissions-read file using method:', id: 'drive-permissions-nonget', file: PERM, code: "await http.request({ method: 'PATCH', path });" },
  { name: 'permissions-read file using raw fetch', id: 'drive-permissions-nonget', file: PERM, code: 'await fetch(url);' },
  { name: 'trashed: true', id: 'drive-trashed', code: 'await http.patch(url, { trashed: true });' },
  { name: '"trashed":true compact', id: 'drive-trashed', code: 'const b = {"trashed":true};' },
  { name: 'emptyTrash', id: 'drive-empty-trash', code: "http.post('/drive/v3/files/emptyTrash')" },
  { name: 'transferOwnership', id: 'drive-transfer-ownership', code: 'const q = { transferOwnership: true };' },

  // Generic
  { name: "'DELETE' string", id: 'delete-verb', code: "const verb = 'DELETE';" },
  { name: '"DELETE" string', id: 'delete-verb', code: 'const verb = "DELETE";' },
  { name: 'split DELETE string', id: 'delete-verb', code: "const verb = 'DEL' + 'ETE';" },
  { name: "http.ts also bans method: 'DELETE'", id: 'delete-method', file: 'src/google/http.ts', code: "fetch(u, { method: 'DELETE' });" },
  { name: 'method: "DELETE" across lines', id: 'delete-method', code: 'fetch(u, {\n  method:\n    "DELETE",\n});' },
  { name: 'lowercase method delete', id: 'delete-method', code: "fetch(u, { method: 'delete' });" },
  { name: 'http.delete(', id: 'http-delete-call', code: 'await this.http.delete(`/x/${id}`);' },
  { name: 'google.delete(', id: 'http-delete-call', code: 'await ctx.google.delete(path);' },
  { name: 'client.delete( on next line', id: 'http-delete-call', code: 'await apiClient\n  .delete(path);' },
  { name: 'optional chain api?.delete(', id: 'http-delete-call', code: 'await api?.delete(path);' },
  { name: "bracket access ['delete'](", id: 'http-delete-call', code: "await anything['delete'](path);" },
  { name: 'raw fetch to googleapis', id: 'google-fetch', code: "const r = await fetch('https://www.googleapis.com/drive/v3/files');" },
  { name: 'raw fetch to gmail host (template)', id: 'google-fetch', code: 'await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, init);' },
  { name: 'raw fetch via new URL', id: 'google-fetch', code: "await fetch(new URL('/calendar/v3', 'https://www.googleapis.com'));" },
  { name: 'import { google } from googleapis', id: 'googleapis-import', code: "import { google } from 'googleapis';" },
  { name: '@googleapis/gmail import', id: 'googleapis-import', code: 'import { gmail } from "@googleapis/gmail";' },
  { name: 'require googleapis', id: 'googleapis-import', code: "const { google } = require('googleapis');" },
  { name: 'dynamic import googleapis', id: 'googleapis-import', code: "const m = await import('googleapis');" },
  { name: 'excluded tool registered', id: 'excluded-tool-name', code: "server.registerTool('send_message', {}, handler);" },
  { name: 'excluded tool, delete_event', id: 'excluded-tool-name', code: 'const tools = ["list_events", "delete_event"];' },
  { name: 'excluded bare tool name registered', id: 'excluded-tool-name', code: "registerTool('forward', cfg, h);" },
  { name: 'excluded bare tool name via name:', id: 'excluded-tool-name', code: "const t = { name: 'reply' };" },

  // ---- Deny-by-default for Google paths (audit bypass snippets 01-04, 27-29, 33-36, 49-52)
  { name: '01 path joined from literals', id: 'google-path-outside-endpoints', code: "const p = ['', 'gmail', 'v1', 'users', 'me', 'messages'].join('/');\nconst h = ['www', 'googleapis', 'com'].join('.');" },
  { name: '01 gmail path joined from literals is also gmail-send', id: 'gmail-send', code: "const p = ['', 'gmail', 'v1', 'users', 'me', 'messages', 'send'].join('/');" },
  { name: '02 host held in a constant', id: 'google-path-outside-endpoints', code: "const HOST = 'gmail.googleapis.com';\nexport const url = `https://${HOST}/x`;" },
  { name: '03 fetch to a host held in a constant', id: 'raw-network-client', file: 'src/google/api.ts', code: "const HOST = base + '.googleapis.com';\nawait fetch(`https://${HOST}/v1/x`, init);" },
  { name: '04 api path in a constant', id: 'google-path-outside-endpoints', code: "const CAL = '/calendar/v3/calendars';\nexport const list = (id: string) => http.json({ method: 'GET', url: CAL + id });" },
  { name: '04 drive v3 path in a constant', id: 'google-path-outside-endpoints', code: "export const FILES = '/drive/v3/files';" },
  { name: '04 batch endpoint', id: 'google-path-outside-endpoints', code: "const B = 'https://www.example.test/batch/calendar';" },
  { name: '04 docs, sheets and slides paths', id: 'google-path-outside-endpoints', code: "const a = '/docs/v1/documents'; const b = '/v4/spreadsheets/'; const c = '/v1/presentations/';" },
  { name: '27 dynamic import by variable', id: 'dynamic-import', file: 'src/google/loader.ts', code: 'const mod = await import(name);' },
  { name: '28 dynamic import of a template', id: 'dynamic-import', file: 'src/google/loader.ts', code: 'const mod = await import(`goog${"leapis"}`);' },
  { name: '29 require by variable', id: 'dynamic-import', file: 'src/mcp/loader.ts', code: 'const lib = require(pkg);' },
  { name: '29 createRequire', id: 'dynamic-code', file: 'src/google/loader.ts', code: "const r = createRequire(import.meta.url);" },
  { name: '29 eval', id: 'dynamic-code', file: 'src/mcp/x.ts', code: "eval(code);" },
  { name: '33 axios import', id: 'raw-network-client', file: 'src/google/api.ts', code: "import axios from 'axios';" },
  { name: '33 axios call', id: 'raw-network-client', file: 'src/mcp/api.ts', code: 'await axios.post(u, body);' },
  { name: '34 got', id: 'raw-network-client', file: 'src/google/api.ts', code: "import got from 'got';" },
  { name: '34 got call', id: 'raw-network-client', file: 'src/google/api.ts', code: 'await got.post(u, { json: b });' },
  { name: '35 undici', id: 'raw-network-client', file: 'src/google/api.ts', code: "import { request } from 'undici';" },
  { name: '35 node-fetch', id: 'raw-network-client', file: 'src/google/api.ts', code: "import nf from 'node-fetch';" },
  { name: '36 XMLHttpRequest', id: 'raw-network-client', file: 'src/google/api.ts', code: 'const x = new XMLHttpRequest();' },
  { name: '36 node:https', id: 'raw-network-client', file: 'src/google/api.ts', code: "import https from 'node:https';" },
  { name: '36 https.request', id: 'raw-network-client', file: 'src/google/api.ts', code: 'https.request(opts, cb);' },
  { name: '36 http.request', id: 'raw-network-client', file: 'src/google/api.ts', code: 'http.request(opts, cb);' },
  { name: '36 globalThis.fetch', id: 'raw-network-client', file: 'src/mcp/api.ts', code: 'await globalThis.fetch(u);' },
  { name: '36 fetch aliased', id: 'raw-network-client', file: 'src/google/api.ts', code: 'const f = fetch;' },
  { name: '36 fetch bracket', id: 'raw-network-client', file: 'src/google/api.ts', code: "await globalThis['fetch'](u);" },
  { name: '36 bare fetch( in an adapter', id: 'raw-network-client', file: 'src/google/calendar/api.ts', code: 'await fetch(url, init);' },
  { name: '36 fetch in a token-adjacent file that is not a token file', id: 'raw-network-client', file: 'src/google/other-token.ts', code: "await fetch(GOOGLE_TOKEN_URL);" },
  { name: '49 trash as a bare path element', id: 'trash-word', file: 'src/google/api.ts', code: "const p = ['messages', id, 'trash'].join('/');" },
  { name: '49 trash string', id: 'trash-word', file: 'src/google/api.ts', code: "const verb = 'trash';" },
  { name: '49 untrash string', id: 'trash-word', file: 'src/google/api.ts', code: 'const verb = `untrash`;' },
  { name: '49 trash appended to a path', id: 'trash-word', file: 'src/google/api.ts', code: "const p = base + '/trash';" },
  { name: '50 delete member on a call', id: 'delete-member', file: 'src/google/api.ts', code: 'await x.delete(`/y/${id}`);' },
  { name: '50 delete member on a chain', id: 'delete-member', file: 'src/google/api.ts', code: 'await build(q).delete(path);' },
  { name: '50 delete member bracket', id: 'delete-member', file: 'src/mcp/api.ts', code: "await x['delete'](path);" },
  { name: '50 delete member optional', id: 'delete-member', file: 'src/google/api.ts', code: 'await x?.delete(path);' },
  { name: '50 delete member as a value', id: 'delete-member', file: 'src/google/api.ts', code: 'const d = client.delete;' },
  { name: '50 delete on reset (not a Set)', id: 'delete-member', file: 'src/google/api.ts', code: 'reset.delete(path);' },
  { name: '51 attendees shorthand', id: 'cal-attendees-write', code: 'const body = { summary, attendees };' },
  { name: '51 attendees shorthand, multi-line', id: 'cal-attendees-write', code: 'const body = {\n  summary,\n  attendees,\n};' },
  { name: '51 attendees dot assignment', id: 'cal-attendees-write', code: 'body.attendees = list;' },
  { name: '51 attendees bracket assignment', id: 'cal-attendees-write', code: "body['attendees'] = list;" },
  { name: '51 attendees push', id: 'cal-attendees-write', code: "body.attendees.push({ email });" },
  { name: '51 attendees via set()', id: 'cal-attendees-write', code: "form.set('attendees', JSON.stringify(list));" },
  { name: '51 computed attendees key', id: 'cal-attendees-write', code: "const body = { ['attendees']: list };" },
  { name: '52 trashed shorthand', id: 'drive-trashed', code: 'await http.json({ method: "PATCH", url, body: { trashed } });' },
  { name: '52 trashed from variable', id: 'drive-trashed', code: 'const b = { trashed: flag };' },
  { name: '52 trashed dot assignment', id: 'drive-trashed', code: 'body.trashed = true;' },
  { name: '52 trashed bracket assignment', id: 'drive-trashed', code: "body['trashed'] = !!x;" },
  { name: '52 trashed numeric', id: 'drive-trashed', code: 'const b = { trashed: 1 };' },
  { name: 'googleapis subpath import', id: 'googleapis-import', code: "import { x } from 'googleapis/build/src/apis/gmail';" },
  { name: 'google-auth-library import', id: 'googleapis-import', code: "import { OAuth2Client } from 'google-auth-library';" },
  { name: 'google-auth-library subpath', id: 'googleapis-import', code: "const m = require('google-auth-library/build/src/auth/oauth2client');" },
  { name: '@googleapis scoped subpath', id: 'googleapis-import', code: "import x from '@googleapis/drive/build/index';" },
  { name: 'token file may only hold the exact token URLs', id: 'google-path-outside-endpoints', file: 'src/google/oauth.ts', code: "const T = 'https://oauth2.googleapis.com/token';\nconst U = 'https://www.googleapis.com/drive/v3/files';" },
  { name: 'token file: a near-miss token URL', id: 'google-path-outside-endpoints', file: 'src/google/token-manager.ts', code: "const T = 'https://oauth2.googleapis.com/tokeninfo';" },
  { name: 'oidc file: another googleapis host', id: 'google-path-outside-endpoints', file: 'src/auth/google-oidc.ts', code: "const T = 'https://gmail.googleapis.com/';" },
  { name: 'token file may not fetch other Google hosts', id: 'google-fetch', file: 'src/google/oauth.ts', code: "await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile');" },
  { name: 'http.ts may not fetch a Google host', id: 'google-fetch', file: 'src/google/http.ts', code: "await fetch('https://www.googleapis.com/drive/v3/files');" },
  { name: 'http.ts may only use its one globalThis.fetch call', id: 'raw-network-client', file: 'src/google/http.ts', code: 'await globalThis.fetch(url, init);' },
  { name: 'scope URL files may not hold API paths', id: 'google-path-outside-endpoints', file: 'src/core/products.ts', code: "const S = 'https://www.googleapis.com/auth/drive'; const P = 'https://www.googleapis.com/drive/v3/files';" },
  { name: 'new extensions are scanned: .cts content', id: 'google-path-outside-endpoints', file: 'src/google/x.cts', code: "module.exports = '/drive/v3/files';" },
];

const BENIGN: { name: string; code: string; file?: string }[] = [
  { name: "sendUpdates: 'none'", code: "const q = { sendUpdates: 'none' };" },
  { name: 'sendUpdates=none in URL', code: 'const u = `${B}/events?sendUpdates=none`;' },
  { name: 'sendUpdates none via params', code: "params.set('sendUpdates', 'none');" },
  { name: 'sendNotifications false', code: 'const q = { sendNotifications: false };' },
  { name: 'reading event.attendees', code: 'const attendees = event.attendees ?? [];' },
  { name: 'reading attendees in expressions', code: 'const others = (event.attendees ?? []).filter((a) => !a.self);\nreturn attendees.length > 0;' },
  { name: 'optional attendees type', code: 'interface E { attendees?: Attendee[] }' },
  { name: 'typed attendees field', code: 'interface E {\n  attendees: Attendee[];\n}' },
  { name: 'reading responseStatus', code: "const accepted = a.responseStatus === 'accepted';" },
  { name: 'responseStatus optional type', code: 'type A = { responseStatus?: string };' },
  { name: 'get_file_permissions via allowlisted read-only path', file: PERM, code: 'const res = await reader.list(`${base}/permissions`, { params: { fields: "permissions(id,role,type)" } });' },
  { name: "'send' inside an unrelated identifier (sendResponse)", code: 'function sendResponse(res: Response) { return res; }\nconst sendUpdatesCount = 3;' },
  { name: 'messages/sendfoo-like identifier text', code: "const messagesSentCount = 0; // messages sent so far" },
  { name: 'local function deleteCachedAccess', code: 'function deleteCachedAccess(id: string) { cache.delete(id); }\ndeleteCachedAccess(a);' },
  { name: 'Map/Set delete on a cache', code: 'tokenCache.delete(accountId);' },
  { name: 'supabase delete on a DB table', file: 'src/lib/other.ts', code: "const { data } = await this.client.from('oauth_codes').delete().eq('code_hash', h).select();" },
  { name: 'supabase delete, chain on next line', file: 'src/lib/other.ts', code: "await this.client\n  .from('oauth_state')\n  .delete()\n  .lt('expires_at', now);" },
  { name: 'trashed=false in a Drive query', code: "const q = \"trashed = false and mimeType != 'x'\";" },
  { name: 'trashed false literal', code: 'const q = { trashed: false };' },
  { name: 'hashToken', code: "export function hashToken(t: string) { return createHash('sha256').update(t).digest('base64url'); }" },
  { name: 'Next route handler named DELETE', code: 'export async function DELETE() { return new Response(null, { status: 405 }); }' },
  { name: "'forward' / 'reply' as ordinary strings", code: "const dir: 'forward' | 'back' = 'forward'; const kind = 'reply';" },
  { name: 'fetch to non-Google URL', file: 'src/lib/other.ts', code: "await fetch('https://example.com/data');" },
  { name: 'fetch in unrelated file mentioning google.com text', file: 'src/lib/other.ts', code: "const doc = 'see google.com'; await fetch(u);" },
  { name: 'http.post to calendar events inside the endpoints dir', file: 'src/google/endpoints/calendar.ts', code: "await http.post(`/calendar/v3/calendars/${c}/events?sendUpdates=none`, body);" },
  { name: 'http.ts naming DELETE in its method allowlist', file: 'src/google/http.ts', code: "if (method === ('DELETE' as string)) throw new Error('DELETE is not supported');" },
  { name: 'token files: exact auth, token and certs URLs', file: 'src/auth/google-oidc.ts', code: "const A = 'https://accounts.google.com/o/oauth2/v2/auth'; const T = 'https://oauth2.googleapis.com/token'; const J = 'https://www.googleapis.com/oauth2/v3/certs';" },
  { name: 'scope identifiers (products.ts)', file: 'src/core/products.ts', code: "calendar: 'https://www.googleapis.com/auth/calendar', gmail: 'https://www.googleapis.com/auth/gmail.modify'," },
  { name: 'google paths inside the endpoints dir', file: 'src/google/endpoints/calendar.ts', code: "export const base = 'https://www.googleapis.com/calendar/v3'; const q = { sendUpdates: 'none' };" },
  { name: 'http.ts default transport', file: 'src/google/http.ts', code: 'const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));' },
  { name: 'fetchImpl option name', file: 'src/google/other.ts', code: 'interface O { fetchImpl?: typeof fetch }\nconst r = await opts.fetchImpl(url);' },
  { name: 'doFetch / spec.fetch( calls', file: 'src/google/other.ts', code: 'const r = await doFetch(url, init); await spec.fetch(a, t);' },
  { name: 'literal dynamic import', file: 'src/google/other.ts', code: "const m = await import('./local');\nconst t = typeof import('./types');" },
  { name: 'Map delete on identifiers ending in Map/Set/Cache', file: 'src/google/other.ts', code: 'inflight.delete(k); this.byIdMap.delete(k); seenSet.delete(x); tokenCache?.delete(a); registrations.delete(k); this.cache.delete(k);' },
  { name: 'Map/Set delete in src/mcp', file: 'src/mcp/other.ts', code: 'sessions.set(a, b); sessionCache.delete(a);' },
  { name: 'reading attendees via destructuring', code: 'const { attendees } = event;\nfunction f({ attendees }: Props) {}\nconst g = ({ attendees }) => attendees.length;\nfor (const { attendees } of events) {}' },
  { name: 'import of an attendees binding', code: "import { attendees } from './x';" },
  { name: 'passing an attendees variable as an argument', code: 'format(a, attendees, b);' },
  { name: 'reading trashed', code: 'const gone = file.trashed === true; if (file.trashed) skip(); interface F { trashed?: boolean; trashed: boolean }' },
  { name: 'trashed destructuring', code: 'const { trashed } = file;' },
  { name: 'words containing trash', file: 'src/google/other.ts', code: 'const trashedTime = f.trashedTime; const explicitlyTrashed = f.explicitlyTrashed;' },
  { name: 'delete outside google/mcp (supabase store)', file: 'src/store/x.ts', code: "await this.client.from('t').delete().eq('id', id);" },
  { name: 'oauth.ts token endpoint fetch', file: 'src/google/oauth.ts', code: "await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });" },
];

describe('excluded-endpoint contract: real source tree', () => {
  it('has no violations in src/', () => {
    const violations = scanSources(['src']);
    expect(violations, `Excluded-endpoint violations:\n${formatViolations(violations)}`).toEqual([]);
  });
});

describe('seeded violations are caught', () => {
  it.each(VIOLATIONS.map((v) => [v.name, v] as const))('%s', (_n, v) => {
    const hits = scanSources(['src'], { [v.file ?? P]: v.code });
    expect(hits.map((h) => h.patternId)).toContain(v.id);
  });

  it('reports file, line, pattern id and text', () => {
    const hits = scanSources([], { [P]: "const a = 1;\nconst b = 'DELETE';\n" });
    expect(hits).toEqual([{ file: P, line: 2, patternId: 'delete-verb', text: "const b = 'DELETE';" }]);
  });

  it('does not exempt comments', () => {
    const hits = scanSources([], { [P]: "// never call /messages/send from here\nexport {};" });
    expect(hits.map((h) => h.patternId)).toEqual(['gmail-send']);
  });

  it('scans .tsx/.js/.mjs content the same way (path agnostic when given inline)', () => {
    for (const f of ['src/a.tsx', 'src/b.js', 'src/c.mjs']) {
      expect(scanSources([], { [f]: "fetch('https://gmail.googleapis.com/x')" }).map((h) => h.patternId)).toContain('google-fetch');
    }
  });
});

describe('allowlist scoping', () => {
  it("src/google/http.ts may mention 'DELETE' but only for that pattern", () => {
    expect(scanSources([], { 'src/google/http.ts': "const BLOCKED = ['DELETE'];" })).toEqual([]);
    const other = scanSources([], { 'src/google/http.ts': "const u = '/messages/send'; const v = { sendUpdates: 'all' };" });
    expect(other.map((h) => h.patternId).sort()).toEqual(['cal-send-updates', 'gmail-send']);
  });

  it("'DELETE' outside http.ts is still caught", () => {
    expect(scanSources([], { 'src/google/other.ts': "const BLOCKED = ['DELETE'];" }).map((h) => h.patternId)).toEqual(['delete-verb']);
  });

  it('allowlist entries are only for known patterns and use repo-relative paths', () => {
    const ids = new Set(BANNED_PATTERNS.map((p) => p.id));
    for (const [id, files] of Object.entries(ALLOWLIST)) {
      expect(ids.has(id), `unknown pattern id in ALLOWLIST: ${id}`).toBe(true);
      for (const f of files) expect(f.startsWith('src/') && !f.startsWith('/')).toBe(true);
    }
  });
});

describe('benign code is not flagged', () => {
  it.each(BENIGN.map((b) => [b.name, b] as const))('%s', (_n, b) => {
    const hits = scanSources(['src'], { [b.file ?? P]: b.code });
    expect(hits, formatViolations(hits)).toEqual([]);
  });
});

describe('assertNoExcludedTools', () => {
  it('passes for the allowed tool surface', () => {
    expect(() => assertNoExcludedTools(['list_accounts', 'list_events', 'create_event', 'create_draft', 'get_file_permissions'])).not.toThrow();
    expect(() => assertNoExcludedTools([])).not.toThrow();
  });

  it.each(EXCLUDED_TOOL_NAMES.map((n) => [n] as const))('rejects %s', (name) => {
    expect(() => assertNoExcludedTools(['list_accounts', name])).toThrow(name);
  });

  it('lists every offender', () => {
    expect(() => assertNoExcludedTools(['send_message', 'ok', 'delete_event'])).toThrow(/send_message, delete_event/);
  });

  it('keeps the excluded list complete and unique', () => {
    expect(new Set(EXCLUDED_TOOL_NAMES).size).toBe(EXCLUDED_TOOL_NAMES.length);
    expect(EXCLUDED_TOOL_NAMES).toHaveLength(25);
    for (const n of ['send_message', 'create_filter', 'respond_to_event', 'create_permission']) expect(EXCLUDED_TOOL_NAMES).toContain(n);
  });
});

describe('meta', () => {
  it('every banned pattern has at least one seeded violation case', () => {
    const covered = new Set(VIOLATIONS.map((v) => v.id));
    const missing = BANNED_PATTERNS.map((p) => p.id).filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it('pattern ids are unique and every seed references a real pattern', () => {
    const ids = BANNED_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VIOLATIONS) expect(ids).toContain(v.id);
  });

  it('every pattern has a description', () => {
    for (const p of BANNED_PATTERNS) expect(p.description.length).toBeGreaterThan(10);
  });
});
