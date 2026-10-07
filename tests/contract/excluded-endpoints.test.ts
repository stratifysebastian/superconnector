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
  { name: 'get_file_permissions via allowlisted read-only path', file: PERM, code: 'const res = await http.get(`/drive/v3/files/${id}/permissions`, { params: { fields: "permissions(id,role,type)" } });' },
  { name: "'send' inside an unrelated identifier (sendResponse)", code: 'function sendResponse(res: Response) { return res; }\nconst sendUpdatesCount = 3;' },
  { name: 'messages/sendfoo-like identifier text', code: "const messagesSentCount = 0; // messages sent so far" },
  { name: 'local function deleteCachedAccess', code: 'function deleteCachedAccess(id: string) { cache.delete(id); }\ndeleteCachedAccess(a);' },
  { name: 'Map/Set delete on a cache', code: 'tokenCache.delete(accountId);' },
  { name: 'supabase delete on a DB table', code: "const { data } = await this.client.from('oauth_codes').delete().eq('code_hash', h).select();" },
  { name: 'supabase delete, chain on next line', code: "await this.client\n  .from('oauth_state')\n  .delete()\n  .lt('expires_at', now);" },
  { name: 'trashed=false in a Drive query', code: "const q = \"trashed = false and mimeType != 'x'\";" },
  { name: 'trashed false literal', code: 'const q = { trashed: false };' },
  { name: 'hashToken', code: "export function hashToken(t: string) { return createHash('sha256').update(t).digest('base64url'); }" },
  { name: 'Next route handler named DELETE', code: 'export async function DELETE() { return new Response(null, { status: 405 }); }' },
  { name: "'forward' / 'reply' as ordinary strings", code: "const dir: 'forward' | 'back' = 'forward'; const kind = 'reply';" },
  { name: 'fetch to non-Google URL', code: "await fetch('https://example.com/data');" },
  { name: 'fetch in unrelated file mentioning google.com text', code: "const doc = 'see google.com'; await fetch(u);" },
  { name: 'http.get/post to calendar events', code: "await http.post(`/calendar/v3/calendars/${c}/events?sendUpdates=none`, body);" },
  { name: 'http.ts naming DELETE in its method allowlist', file: 'src/google/http.ts', code: "if (method === ('DELETE' as string)) throw new Error('DELETE is not supported');" },
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
