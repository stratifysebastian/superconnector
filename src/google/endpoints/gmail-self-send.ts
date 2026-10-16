import { randomUUID } from 'node:crypto';
import type { EndpointRule } from './policy';
import { gmailUrl } from './urls';

/**
 * The ONLY place in src/ that names the Gmail send path (the contract scan allows exactly this one literal, and
 * only here). The rule below is the only way a send can pass the policy: transport 'self-send', and a body whose
 * decoded headers address nobody except the account itself. Every other send path stays hard-banned in guards.ts.
 */
const SEND_PATH = '/users/me/messages/send';

export const SELF_SEND_URL = gmailUrl(SEND_PATH);
/** Anchored, and exactly this path; the policy matches it against the raw pathname. */
export const SELF_SEND_PATH = `/gmail/v1${SEND_PATH}`;

/** A plain address: no display name, angle brackets, quotes, comments or whitespace. */
export const isPlainAddress = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(s);

/** Only these top-level headers may exist; anything else (Cc, Bcc, Reply-To, Sender, Resent-*, ...) is a denial. */
const ALLOWED_HEADERS = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'];

/** Returns why the raw message could reach anyone but `selfEmail`, or null. */
export function checkSelfRaw(raw: string, selfEmail: string | undefined): string | null {
  if (!isPlainAddress(selfEmail)) return 'the account address is missing or is not a plain address';
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return 'raw must be base64url';
  const text = Buffer.from(raw, 'base64url').toString('latin1');
  // CRLF only: a stray CR or LF could end the header block for this checker but not for Gmail (A6 F1).
  if (/\r(?!\n)|(?<!\r)\n/.test(text)) return 'line breaks must be CRLF';
  // Any CR or LF is a line break (a stricter reader than Gmail's, so nothing hides behind a bare CR).
  const lines = text.split(/\r\n|\r|\n/);
  const end = lines.indexOf('');
  if (end < 0) return 'message has no header/body separator';
  const headers: { name: string; value: string }[] = [];
  for (const line of lines.slice(0, end)) {
    if (!/^[\x20-\x7e\t]*$/.test(line)) return 'headers must be plain ASCII';
    if (/^[ \t]/.test(line)) {
      const last = headers[headers.length - 1];
      if (!last) return 'header block starts with a continuation line';
      // A folded line that looks like a header is a header hidden inside another one.
      if (/^[ \t]*[!-9;-~]+[ \t]*:/.test(line)) return 'a folded line looks like a hidden header';
      last.value += ` ${line.trim()}`;
      continue;
    }
    const m = /^([!-9;-~]+):(.*)$/.exec(line);
    if (!m) return 'malformed header line';
    headers.push({ name: m[1]!.toLowerCase(), value: m[2]!.trim() });
  }
  const bad = headers.find((h) => !ALLOWED_HEADERS.includes(h.name));
  if (bad) return `header "${bad.name}" is not allowed (this message may only be From and To the account itself)`;
  for (const name of ['to', 'from']) {
    const vals = headers.filter((h) => h.name === name);
    if (vals.length !== 1) return `exactly one ${name} header is required`;
    if (vals[0]!.value.toLowerCase() !== selfEmail.toLowerCase()) return `${name} must be exactly the account's own address`;
  }
  return null;
}

function checkSelfBody(body: unknown, ctx: { selfEmail?: string }): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'raw') return 'body must contain exactly "raw" (no threadId or other fields)';
  const raw = (body as { raw: unknown }).raw;
  if (typeof raw !== 'string' || raw === '') return 'raw must be a non-empty string';
  return checkSelfRaw(raw, ctx.selfEmail);
}

export const SELF_SEND_RULE: EndpointRule = {
  id: 'gmail.self-send',
  product: 'gmail',
  method: 'POST',
  host: 'gmail.googleapis.com',
  path: new RegExp(`^${SELF_SEND_PATH}$`),
  allowedQuery: [],
  transport: 'self-send',
  checkBody: checkSelfBody,
};

// ---- MIME for sendToSelf -----------------------------------------------------------------------------------------

const ascii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);
const wrap76 = (b64: string): string => b64.replace(/(.{76})(?=.)/g, '$1\r\n');
const b64 = (s: string): string => wrap76(Buffer.from(s, 'utf8').toString('base64'));

/** Control characters (CR, LF, NUL, C1, line/paragraph separators) become one space. */
const cleanSubject = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

/** RFC 2047 encoded-words (UTF-8, base64), each at most 75 characters and never cutting a character. */
function encodeSubject(s: string): string {
  const v = cleanSubject(s);
  if (ascii(v)) return v;
  const words: string[] = [];
  let cur = '';
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch) > 42) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** From and To are both `self`; no other recipient-bearing header exists in the output. */
export function buildSelfMime(self: string, m: { subject: string; body: string; htmlBody?: string }): string {
  const head = [
    `From: ${self}`,
    `To: ${self}`,
    `Subject: ${encodeSubject(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${self.split('@')[1]}>`,
    'MIME-Version: 1.0',
  ];
  const part = (type: string, text: string) =>
    `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}`;
  if (m.htmlBody === undefined) return `${head.join('\r\n')}\r\n${part('text/plain', m.body)}\r\n`;
  const bd = `sc_${randomUUID().replace(/-/g, '')}`;
  return (
    `${head.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${bd}"\r\n\r\n` +
    `--${bd}\r\n${part('text/plain', m.body)}\r\n--${bd}\r\n${part('text/html', m.htmlBody)}\r\n--${bd}--\r\n`
  );
}
