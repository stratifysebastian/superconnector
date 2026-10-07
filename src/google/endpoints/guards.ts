/**
 * Hard bans: applied to every request, even when an endpoint rule would match (defence in depth).
 * This file necessarily names the forbidden things, so it is the one policy file the text scan exempts.
 */

const BANNED_CUSTOM_METHODS = ['send', 'trash', 'untrash', 'batchdelete', 'import', 'insert', 'delete', 'quickadd', 'emptytrash'];

const BANNED_BODY_KEYS = [
  'attendees',
  'addedattendees',
  'attendeeemails',
  'addedattendeeemails',
  'removedattendeeemails',
  'guestpermissions',
];

const OVERRIDE_QUERY_KEYS = ['x-http-method-override', '_method', 'httpmethod'];

export interface Ban {
  rule: string;
  reason: string;
}

/** `pathname` is the URL's pathname (still percent-encoded). */
export function pathBan(method: string, pathname: string, query: Record<string, string>): Ban | null {
  let segs: string[];
  try {
    segs = pathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s).toLowerCase());
  } catch {
    return { rule: 'hard-ban/bad-encoding', reason: 'path has invalid percent-encoding' };
  }
  const gmail = segs.includes('gmail');

  for (const s of segs) {
    const colon = s.indexOf(':');
    if (colon >= 0 && BANNED_CUSTOM_METHODS.includes(s.slice(colon + 1))) {
      return { rule: 'hard-ban/custom-method', reason: `custom method ":${s.slice(colon + 1)}" is not allowed` };
    }
    const base = colon >= 0 ? s.slice(0, colon) : s;
    if (base === 'batch') return { rule: 'hard-ban/batch', reason: 'batch endpoints are not allowed' };
    if (base === 'acl') return { rule: 'hard-ban/acl', reason: 'ACL endpoints (sharing) are not allowed' };
    if (base === 'quickadd') return { rule: 'hard-ban/quickadd', reason: 'quickAdd is not allowed' };
    if (['trash', 'untrash', 'emptytrash', 'batchdelete', 'import'].includes(base)) {
      return { rule: `hard-ban/${base}`, reason: `"${base}" endpoints are not allowed (no trash, delete or import)` };
    }
    if (gmail && (base === 'send' || base === 'insert')) {
      return { rule: `hard-ban/gmail-${base}`, reason: `Gmail "${base}" is not allowed (drafts only)` };
    }
  }
  if (gmail) {
    const i = segs.indexOf('users');
    if (i >= 0 && segs[i + 2] === 'settings') {
      return { rule: 'hard-ban/gmail-settings', reason: 'Gmail settings (filters, forwarding, delegates) are not allowed' };
    }
  }
  if (method !== 'GET' && segs.includes('permissions')) {
    return { rule: 'hard-ban/permissions-write', reason: 'permission changes are not allowed' };
  }
  if (segs[0] === 'calendar' && method !== 'GET' && query['sendUpdates'] !== 'none') {
    return { rule: 'hard-ban/calendar-send-updates', reason: 'Calendar writes require sendUpdates=none' };
  }
  return null;
}

export function queryBan(query: Record<string, string>): Ban | null {
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('$')) return { rule: 'hard-ban/query-dollar', reason: 'query keys starting with "$" are not allowed' };
    const lk = k.toLowerCase();
    if (OVERRIDE_QUERY_KEYS.includes(lk)) {
      return { rule: 'hard-ban/method-override', reason: 'HTTP method override parameters are not allowed' };
    }
    if (lk === 'sendupdates' && v !== 'none') return { rule: 'hard-ban/send-updates', reason: 'sendUpdates must be "none"' };
    if (lk === 'sendnotifications' && v !== 'false') {
      return { rule: 'hard-ban/send-notifications', reason: 'sendNotifications must be false' };
    }
    if (lk === 'transferownership') return { rule: 'hard-ban/transfer-ownership', reason: 'transferOwnership is not allowed' };
  }
  return null;
}

const MAX_DEPTH = 64;

/** Recursive checks on the (already JSON-round-tripped) request body. */
export function bodyBan(value: unknown, depth = 0, key = ''): Ban | null {
  if (depth > MAX_DEPTH) return { rule: 'hard-ban/body-depth', reason: 'request body is nested too deeply' };
  if (Array.isArray(value)) {
    const labelArray = /labelIds$/i.test(key);
    for (const el of value) {
      if (labelArray && typeof el === 'string' && el.trim().toUpperCase() === 'TRASH') {
        return { rule: 'hard-ban/trash-label', reason: 'the TRASH label is not allowed' };
      }
      const b = bodyBan(el, depth + 1, labelArray ? key : '');
      if (b) return b;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const lower = keys.map((k) => k.toLowerCase());
  for (const lk of lower) {
    if (lk === 'responsestatus') return { rule: 'hard-ban/rsvp', reason: 'responseStatus (RSVP) is not allowed' };
    if (BANNED_BODY_KEYS.includes(lk)) return { rule: 'hard-ban/attendees', reason: `"${lk}" is not allowed in a request body` };
  }
  for (let i = 0; i < keys.length; i++) {
    if (lower[i] !== 'trashed') continue;
    const t = obj[keys[i]!];
    if (t === true || (typeof t === 'string' && t.toLowerCase() === 'true')) {
      return { rule: 'hard-ban/trashed', reason: 'trashed: true is not allowed' };
    }
  }
  if ((lower.includes('role') || lower.includes('type')) && (lower.includes('emailaddress') || lower.includes('domain'))) {
    return { rule: 'hard-ban/permission-shape', reason: 'permission-shaped objects are not allowed' };
  }
  for (const k of keys) {
    const b = bodyBan(obj[k], depth + 1, k);
    if (b) return b;
  }
  return null;
}
