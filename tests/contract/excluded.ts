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
}

/** pattern id -> repo-relative files allowed to match it. Every other pattern still applies to those files. */
export const ALLOWLIST: Record<string, string[]> = {
  // GoogleHttp has no DELETE method; it may name 'DELETE' only inside its method-allowlist rejection logic.
  // This file is NOT allowed for any other pattern (in particular `delete-method`).
  // src/core/contracts/adapter.ts: a doc comment ("no 'DELETE' method exists on GoogleHttp"), no code. Remove this
  // entry if that comment is ever reworded.
  'delete-verb': ['src/google/http.ts', 'src/core/contracts/adapter.ts'],

  // The one place Drive permissions may be mentioned: a dedicated read-only (GET) file backing
  // get_file_permissions. The `drive-permissions-nonget` pattern polices this file for any write verb.
  'drive-permissions': ['src/google/drive/permissions-read.ts'],

  // Raw fetch() to Google hosts: the shared HTTP client, plus the OAuth token endpoint callers
  // (code exchange, refresh, revoke), which are not Bearer API calls and cannot go through GoogleHttp.
  'google-fetch': ['src/google/http.ts', 'src/google/oauth.ts', 'src/google/token-manager.ts'],
};

// Single-word names (reply, forward) are common English/identifiers, so those only count in a registration call.
const toolAlt = EXCLUDED_TOOL_NAMES.filter((n) => n.includes('_')).join('|');
const bareToolAlt = EXCLUDED_TOOL_NAMES.filter((n) => !n.includes('_')).join('|');

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
    description: 'attendees / addedAttendees / attendeeEmails (and siblings) as an outgoing object key; event.attendees reads are fine',
    regex:
      /(?<![.\w$])["'`]?(?:attendees|addedAttendees|attendeeEmails|addedAttendeeEmails|removedAttendeeEmails|guestPermissions)["'`]?\s*:\s*(?!(?:[A-Z]\w*(?:\[\]|<)|Array<|ReadonlyArray<|readonly\s|string\[\]|unknown\b))\S/,
  },

  // ---- Drive
  { id: 'drive-permissions', description: 'any /permissions URL (share/unshare); reads only via the allowlisted read-only file', regex: /\/permissions\b/ },
  {
    id: 'drive-permissions-nonget',
    description: 'write verb or raw fetch inside the allowlisted read-only permissions file',
    regex: /\.(?:post|patch|put|request)\s*[(<]|\bmethod\s*:|\b(?:POST|PATCH|PUT)\b|\bfetch\s*\(/,
    onlyFiles: ALLOWLIST['drive-permissions'] ?? [],
  },
  { id: 'drive-trashed', description: 'trashed: true (trashes a file)', regex: /\btrashed["'`]?\s*[:=]\s*true\b/ },
  { id: 'drive-empty-trash', description: 'Drive emptyTrash', regex: /\bemptyTrash\b/ },
  { id: 'drive-transfer-ownership', description: 'Drive transferOwnership', regex: /\btransferOwnership\b/ },

  // ---- Generic
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
    description: "import/require of 'googleapis' or '@googleapis/*' SDKs",
    regex: /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"`](?:googleapis(?:-common)?|@googleapis\/[\w.-]+)['"`]/,
  },
  {
    id: 'excluded-tool-name',
    description: 'an excluded MCP tool name used as a string (would register or reference it)',
    regex: new RegExp(`['"\`](?:${toolAlt})['"\`]|\\b(?:registerTool|tool|name)\\s*[(:]\\s*['"\`](?:${bareToolAlt})['"\`]`),
  },
];
