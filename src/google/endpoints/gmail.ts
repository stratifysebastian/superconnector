import type { EndpointRule } from './policy';

const HOST = 'gmail.googleapis.com';
const BASE = String.raw`^/gmail/v1/users/me`;
const ID = String.raw`[^/]+`;
// Draft ids may never be the literal segment "send" (the hard bans in guards.ts also deny it).
const DRAFT_ID = String.raw`(?!send$)[^/]+`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): string | null => {
  const bad = Object.keys(o).find((k) => !keys.includes(k));
  return bad ? `field "${bad}" is not allowed` : null;
};

/** Draft writes save a draft only: exactly { message: { raw, threadId? } } (PUT may also repeat the draft id). */
const checkDraftBody = (allowId: boolean) => (body: unknown): string | null => {
  if (!isObj(body)) return 'draft body must be a JSON object';
  const top = onlyKeys(body, allowId ? ['id', 'message'] : ['message']);
  if (top) return top;
  if (body.id !== undefined && typeof body.id !== 'string') return 'draft id must be a string';
  const m = body.message;
  if (!isObj(m)) return 'draft body needs a message object';
  const inner = onlyKeys(m, ['raw', 'threadId']);
  if (inner) return `message ${inner}`;
  if (typeof m.raw !== 'string' || m.raw === '') return 'message.raw must be a non-empty string';
  if (m.threadId !== undefined && typeof m.threadId !== 'string') return 'message.threadId must be a string';
  return null;
};

function checkLabelBody(body: unknown): string | null {
  if (!isObj(body)) return 'label body must be a JSON object';
  const bad = onlyKeys(body, ['name', 'labelListVisibility', 'messageListVisibility', 'color']);
  if (bad) return `label ${bad}`;
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name === '')) return 'label name must be a non-empty string';
  for (const k of ['labelListVisibility', 'messageListVisibility']) {
    if (body[k] !== undefined && typeof body[k] !== 'string') return `${k} must be a string`;
  }
  if (body.color !== undefined) {
    if (!isObj(body.color)) return 'label color must be an object';
    const c = onlyKeys(body.color, ['backgroundColor', 'textColor']);
    if (c) return `label color ${c}`;
  }
  return null;
}

// guards.ts already denies the system trash label in any *LabelIds array; this repeats it without naming the literal.
const SYSTEM_BIN = /^trash$/i;

function checkModifyBody(body: unknown): string | null {
  if (!isObj(body)) return 'modify body must be a JSON object';
  const bad = onlyKeys(body, ['addLabelIds', 'removeLabelIds']);
  if (bad) return `modify ${bad}`;
  for (const k of ['addLabelIds', 'removeLabelIds']) {
    const v = body[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${k} must be an array of strings`;
    if ((v as string[]).some((x) => SYSTEM_BIN.test(x.trim()))) return `${k} may not contain the bin label`;
  }
  return null;
}

const rule = (id: string, method: EndpointRule['method'], path: string, allowedQuery: string[], checkBody?: EndpointRule['checkBody']): EndpointRule => ({
  id: `gmail.${id}`, product: 'gmail', method, host: HOST, path: new RegExp(`${BASE}${path}$`), allowedQuery, ...(checkBody ? { checkBody } : {}),
});

export const GMAIL_RULES: EndpointRule[] = [
  rule('threads.list', 'GET', '/threads', ['q', 'maxResults', 'pageToken', 'includeSpamTrash', 'labelIds']),
  rule('threads.get', 'GET', `/threads/${ID}`, ['format', 'metadataHeaders']),
  rule('messages.get', 'GET', `/messages/${ID}`, ['format', 'metadataHeaders']),
  rule('messages.attachments.get', 'GET', `/messages/${ID}/attachments/${ID}`, []),
  rule('drafts.list', 'GET', '/drafts', ['q', 'maxResults', 'pageToken']),
  rule('drafts.get', 'GET', `/drafts/${DRAFT_ID}`, ['format']),
  rule('drafts.create', 'POST', '/drafts', [], checkDraftBody(false)),
  rule('drafts.update', 'PUT', `/drafts/${DRAFT_ID}`, [], checkDraftBody(true)),
  rule('labels.list', 'GET', '/labels', []),
  rule('labels.get', 'GET', `/labels/${ID}`, []),
  rule('labels.create', 'POST', '/labels', [], checkLabelBody),
  rule('labels.patch', 'PATCH', `/labels/${ID}`, [], checkLabelBody),
  rule('messages.modify', 'POST', `/messages/${ID}/modify`, [], checkModifyBody),
  rule('threads.modify', 'POST', `/threads/${ID}/modify`, [], checkModifyBody),
];
