/**
 * Excluded-endpoint contract: the single source of truth for what no adapter may touch.
 *
 * Guardrails live in the server. Excluded tools are never registered and no adapter may reference an
 * excluded Google endpoint, even where the granted OAuth scope would technically allow it
 * (gmail.compose can send, the drive scope can share and delete).
 *
 * Keep ALLOWLIST explicit, small and reviewed. Every entry needs a comment saying why.
 */

export const EXCLUDED_TOOL_NAMES: readonly string[] = [
  'send_message',
  'send_draft',
  'reply',
  'reply_all',
  'forward',
  'trash_message',
  'trash_thread',
  'untrash_message',
  'untrash_thread',
  'batch_apply_sensitive_message_labels',
  'batch_apply_sensitive_thread_labels',
  'delete_draft',
  'delete_label',
  'delete_message',
  'delete_thread',
  'create_filter', // stays excluded until Seb decides
  'delete_filter',
  'delete_event',
  'respond_to_event',
  'share_file',
  'trash_file',
  'delete_file',
  'update_file_permissions',
  'create_permission',
  'delete_permission',
];

/** Throws if any registered MCP tool name is excluded. Later MCP tests call this with the registry's names. */
export function assertNoExcludedTools(names: readonly string[]): void {
  const excluded = new Set(EXCLUDED_TOOL_NAMES);
  const hits = names.filter((n) => excluded.has(n));
  if (hits.length > 0) {
    throw new Error(`Excluded tool(s) registered: ${hits.join(', ')}`);
  }
}

export interface BannedPattern {
  id: string;
  description: string;
  /** Tested per line and, after normalisation, against the whole file. The scanner adds the `g` flag itself. */
  regex: RegExp;
  /** If set, the pattern applies only to these repo-relative files (used to police allowlisted files). */
  onlyFiles?: readonly string[];
  /** If set, the pattern applies only to files whose repo-relative path starts with one of these prefixes. */
  onlyUnder?: readonly string[];
  /** The pattern does not apply to files under these prefixes. */
  skipUnder?: readonly string[];
  /** The pattern does not apply to these exact files. */
  skipFiles?: readonly string[];
}

/** The three files that talk to Google's OAuth/OIDC endpoints. They are the only src/ files that may use raw fetch. */
export const TOKEN_FILES: readonly string[] = ['src/google/oauth.ts', 'src/google/token-manager.ts', 'src/auth/google-oidc.ts'];
const TOKEN_URLS = [
  'https://oauth2.googleapis.com/token',
  'https://accounts.google.com/o/oauth2/v2/auth',
  'https://www.googleapis.com/oauth2/v3/certs',
];
/** OAuth scope identifiers are names, not API endpoints (https://www.googleapis.com/auth/calendar). */
const SCOPE_URLS = /https:\/\/www\.googleapis\.com\/auth\/[\w.-]+/g;

/**
 * pattern id -> file -> exact literals that file may contain. The literals are removed before matching, so any
 * other use of the pattern in the same file is still a violation (unlike ALLOWLIST, which exempts a whole file).
 */
export const ALLOWED_LITERALS: Record<string, Record<string, readonly (string | RegExp)[]>> = {
  'google-path-outside-endpoints': {
    ...Object.fromEntries(TOKEN_FILES.map((f) => [f, TOKEN_URLS])),
    'src/core/products.ts': [SCOPE_URLS],
    'src/google/mock/seed.ts': [SCOPE_URLS],
  },
  'google-fetch': Object.fromEntries(TOKEN_FILES.map((f) => [f, TOKEN_URLS])),
  // The shared client's default transport. Its host and path checks live in src/google/endpoints.
  'raw-network-client': { 'src/google/http.ts': ['globalThis.fetch(...a)'] },
};

/**
 * The endpoint policy has to name what it forbids (send, trash, attendees, ...), so the text scan cannot read it.
 * It is covered by runtime tests (tests/google/http.test.ts) instead. No other file under src/google/endpoints is
 * exempt, and the exemption is per pattern.
 */
const GUARDS_FILE = 'src/google/endpoints/guards.ts';
const GUARDS_EXEMPT = [
  'gmail-send',
  'gmail-trash',
  'gmail-trash-label',
  'gmail-batch-delete',
  'gmail-import-insert',
  'gmail-filters',
  'gmail-forwarding',
  'gmail-sendas',
  'gmail-delegates',
  'cal-send-updates',
  'cal-send-notifications',
  'cal-acl',
  'cal-quickadd',
  'cal-rsvp',
  'cal-attendees-write',
  'drive-permissions',
  'drive-trashed',
  'drive-empty-trash',
  'drive-transfer-ownership',
];

/** pattern id -> repo-relative files allowed to match it. Every other pattern still applies to those files. */
export const ALLOWLIST: Record<string, string[]> = {
  // GoogleHttp has no DELETE method; it may name 'DELETE' only inside its method-allowlist rejection logic.
  // This file is NOT allowed for any other pattern (in particular `delete-method`).
  'delete-verb': ['src/google/http.ts'],

  // The one place Drive permissions may be mentioned: a dedicated read-only (GET) file backing
  // get_file_permissions. The `drive-permissions-nonget` pattern polices this file for any write verb.
  'drive-permissions': ['src/google/drive/permissions-read.ts', GUARDS_FILE],

  ...Object.fromEntries(GUARDS_EXEMPT.filter((id) => id !== 'drive-permissions').map((id) => [id, [GUARDS_FILE]])),
};

// Single-word names (reply, forward) are common English/identifiers, so those only count in a registration call.
const toolAlt = EXCLUDED_TOOL_NAMES.filter((n) => n.includes('_')).join('|');
const bareToolAlt = EXCLUDED_TOOL_NAMES.filter((n) => !n.includes('_')).join('|');

const ATTENDEE_KEYS = 'attendees|addedAttendees|attendeeEmails|addedAttendeeEmails|removedAttendeeEmails|guestPermissions';

/**
 * `{ key }` / `{ a, key, b }` shorthand in an object literal. Destructuring (`const { key } = x`, `({ key }) =>`,
 * `({ key }: Props)`, `{ key } from`) only reads, so it is excluded by looking at what follows the closing brace.
 */
const SHORTHAND = (keys: string) =>
  `\\{(?:[^{}]*,)?\\s*(?:${keys})\\s*(?=[,}])(?![^{}]*\\}\\s*\\)?\\s*(?:=(?!=)|=>|of\\b|in\\b|from\\b|:\\s*(?:[A-Z]|\\{)))`;

const PLAIN_ASSIGN = (keys: string) =>
  `\\.\\s*(?:${keys})\\s*=(?!=)|\\.\\s*(?:${keys})\\s*\\.\\s*push\\s*\\(|\\[\\s*['"\`](?:${keys})['"\`]\\s*\\]\\s*(?:=(?!=)|:)|\\.\\s*(?:set|append)\\s*\\(\\s*['"\`](?:${keys})['"\`]`;

export const BANNED_PATTERNS: readonly BannedPattern[] = [
  // ---- Gmail
  { id: 'gmail-send', description: 'Gmail messages/send or drafts/send (sends mail)', regex: /\b(?:messages|drafts)\/send\b/ },
  { id: 'gmail-trash', description: 'any /trash or /untrash path segment (Gmail messages and threads)', regex: /[/:](?:un)?trash\b/ },
  { id: 'gmail-trash-label', description: "'TRASH' label string (messages.modify with addLabelIds TRASH trashes mail)", regex: /['"`]TRASH['"`]/ },
  { id: 'gmail-batch-delete', description: 'Gmail batchDelete (permanent delete)', regex: /\bbatchDelete\b/ },
  { id: 'gmail-import-insert', description: 'Gmail messages/import or messages/insert (injects mail)', regex: /\bmessages\/(?:import|insert)\b/ },
  { id: 'gmail-filters', description: 'Gmail settings/filters (filters can auto-forward or delete)', regex: /\bsettings\/filters\b/ },
  { id: 'gmail-forwarding', description: 'Gmail forwardingAddresses / autoForwarding settings', regex: /\b(?:settings\/forwardingAddresses|autoForwarding)\b/ },
  { id: 'gmail-sendas', description: 'Gmail settings/sendAs (send-as aliases)', regex: /\bsettings\/sendAs\b/ },
  { id: 'gmail-delegates', description: 'Gmail settings/delegates', regex: /\bsettings\/delegates\b/ },

  // ---- Calendar
  {
    id: 'cal-send-updates',
    description: 'sendUpdates set to anything other than none (notifies guests)',
    regex: /\bsendUpdates["'`]?\]?\s*[:=]\s*(?!["'`]?none\b)\S|\bsendUpdates["'`]\s*,\s*(?!["'`]none["'`])\S|\bsendUpdates\s*[,}]/,
  },
  {
    id: 'cal-send-notifications',
    description: 'sendNotifications set to anything other than false (notifies guests)',
    regex: /\bsendNotifications["'`]?\]?\s*[:=]\s*(?!["'`]?false\b)\S/,
  },
  { id: 'cal-acl', description: 'Calendar ACL endpoint (sharing)', regex: /\/acl\b/ },
  { id: 'cal-quickadd', description: 'Calendar quickAdd (can invite from free text)', regex: /\bquickAdd\b/ },
  {
    id: 'cal-rsvp',
    description: 'responseStatus assignment (an RSVP); reading it is fine',
    regex: /\bresponseStatus["'`]?\]?\s*(?::|=(?!=))\s*(?!(?:string|unknown|null|undefined)\b|z\.)\S/,
  },
  {
    id: 'cal-attendees-write',
    description:
      'attendees / addedAttendees / attendeeEmails (and siblings) written as an object key, shorthand, dot/bracket assignment or set(); event.attendees reads are fine',
    regex: new RegExp(
      `(?<![.\\w$])["'\`]?(?:${ATTENDEE_KEYS})["'\`]?\\s*:\\s*(?!(?:[A-Z]\\w*(?:\\[\\]|<)|Array<|ReadonlyArray<|readonly\\s|string\\[\\]|unknown\\b))\\S|${SHORTHAND(ATTENDEE_KEYS)}|${PLAIN_ASSIGN(ATTENDEE_KEYS)}`,
    ),
  },

  // ---- Drive
  { id: 'drive-permissions', description: 'any /permissions URL (share/unshare); reads only via the allowlisted read-only file', regex: /\/permissions\b/ },
  {
    id: 'drive-permissions-nonget',
    description: 'write verb or raw fetch inside the allowlisted read-only permissions file',
    regex: /\.(?:post|patch|put|request)\s*[(<]|\bmethod\s*:|\b(?:POST|PATCH|PUT)\b|\bfetch\s*\(/,
    onlyFiles: ['src/google/drive/permissions-read.ts'],
  },
  {
    id: 'drive-trashed',
    description: 'trashed set to anything but false (key, shorthand, dot or bracket form); reading it is fine',
    regex: new RegExp(
      `\\btrashed["'\`]?\\]?\\s*[:=](?!=)\\s*(?!(?:false|boolean|string|unknown|null|undefined)\\b|z\\.)\\S|${SHORTHAND('trashed')}`,
    ),
  },
  { id: 'drive-empty-trash', description: 'Drive emptyTrash', regex: /\bemptyTrash\b/ },
  { id: 'drive-transfer-ownership', description: 'Drive transferOwnership', regex: /\btransferOwnership\b/ },

  // ---- Generic
  {
    id: 'rules-injection',
    description: 'a `rules` option passed to createGoogleHttp under src/ (only tests may inject endpoint rules)',
    regex: /\bcreateGoogleHttp\s*\([\s\S]{0,800}?\brules\b\s*[:,}]/,
    onlyUnder: ['src/'],
  },
  { id: 'delete-verb', description: "the string 'DELETE' / \"DELETE\" / `DELETE`", regex: /(['"`])DELETE\1/ },
  { id: 'delete-method', description: 'method: DELETE in any case (may span lines)', regex: /\bmethod["'`]?\s*[:=]\s*['"`]delete['"`]/i },
  {
    id: 'http-delete-call',
    description: '.delete( on anything named http/google/client/api (Supabase .from(..).delete() is not matched) or ["delete"]( access',
    regex: /\w*(?:http|google|client|api)\w*\s*\??\.\s*delete\s*\(|\[\s*['"`]delete['"`]\s*\]\s*\(/i,
  },
  {
    id: 'google-fetch',
    description: 'raw fetch( to a Google host outside the shared client',
    regex: /\bfetch\s*\(\s*(?:new\s+URL\s*\(\s*)?[^)]*?(?:googleapis\.com|accounts\.google\.com|google\.com)/,
  },
  {
    id: 'googleapis-import',
    description: "any module specifier for 'googleapis', '@googleapis/*' or 'google-auth-library' (prefix match, subpaths count)",
    regex: /['"`](?:googleapis(?:-common)?|google-auth-library|gaxios|gtoken)(?:\/[^'"`\n]*)?['"`]|['"`]@googleapis\/[^'"`\n]*['"`]/,
  },

  // ---- Deny by default for Google paths and network access
  {
    id: 'google-path-outside-endpoints',
    description: 'a Google host or API path anywhere under src/ outside src/google/endpoints (token/auth/certs URLs allowed per file)',
    regex:
      /googleapis|\/gmail\/v1|\/upload\/gmail|\/calendar\/v3|\/drive\/v3|\/drive\/v2|\/upload\/drive|\/docs\/v1|\/v4\/spreadsheets|\/v1\/presentations|\/batch/,
    skipUnder: ['src/google/endpoints/'],
  },
  {
    id: 'raw-network-client',
    description: 'a raw network client (fetch, axios, got, undici, node-fetch, XHR, node:http(s), ...) under src/google or src/mcp',
    regex:
      /(?<![\w$.])fetch\s*(?:\(|\.\s*(?:call|apply|bind)\b)|\b(?:globalThis|window|self|global)\s*\.\s*fetch\b|\[\s*['"`]fetch['"`]\s*\]|[=,(|?]\s*fetch\s*[;,)]|\b(?:axios|undici|node-fetch|XMLHttpRequest)\b|(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"`](?:got|ky|superagent|cross-fetch|https?|node:(?:https?|http2|net|tls|dgram|child_process))['"`]|\bhttps\s*\.\s*(?:request|get)\s*\(|\bhttp\s*\.\s*request\s*\(|\bgot\s*(?:\.\s*(?:get|post|put|patch|stream)\s*)?\(|\bnew\s+(?:WebSocket|EventSource)\s*\(/,
    onlyUnder: ['src/google/', 'src/mcp/'],
    skipFiles: TOKEN_FILES,
  },
  {
    id: 'dynamic-import',
    description: 'import( or require( with a non-literal argument (could load any client or SDK)',
    regex: /\b(?:import|require)\s*\(\s*(?!(?:'[^'\n]*'|"[^"\n]*")\s*\))/,
    onlyUnder: ['src/google/', 'src/mcp/'],
  },
  {
    id: 'dynamic-code',
    description: 'eval, new Function, createRequire, module.require or string-decoding helpers under src/google or src/mcp',
    regex: /\beval\s*\(|\bnew\s+Function\s*\(|\bcreateRequire\b|\bmodule\s*\.\s*require\b|\bprocess\s*\.\s*binding\b|\bfromCharCode\b|\batob\s*\(/,
    onlyUnder: ['src/google/', 'src/mcp/'],
    skipFiles: TOKEN_FILES,
  },

  // ---- Trash and delete, stronger forms
  {
    id: 'trash-word',
    description: "'trash' / 'untrash' as a bare word, string or path/join element under src/google outside the endpoints dir",
    regex: /(?<![\w$])(?:un)?trash(?![\w$])/i,
    onlyUnder: ['src/google/'],
    skipUnder: ['src/google/endpoints/'],
  },
  {
    id: 'delete-member',
    description:
      "'delete' as a member name on any receiver (x.delete(, x?.delete, x['delete']) under src/google or src/mcp; Map/Set/cache receivers are fine",
    regex:
      /(?<!(?:\b(?:cache|map|set)|(?:Map|Set|Cache|inflight|registrations))\s*\??)\??\.\s*delete\b|\[\s*['"`]delete['"`]\s*\]/,
    onlyUnder: ['src/google/', 'src/mcp/'],
  },
  {
    id: 'excluded-tool-name',
    description: 'an excluded MCP tool name used as a string (would register or reference it)',
    regex: new RegExp(`['"\`](?:${toolAlt})['"\`]|\\b(?:registerTool|tool|name)\\s*[(:]\\s*['"\`](?:${bareToolAlt})['"\`]`),
  },
];
