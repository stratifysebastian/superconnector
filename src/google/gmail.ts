import type { AdapterContext } from '@/core/contracts/adapter';
import type { Page } from '@/core/contracts/calendar';
import type {
  DraftAttachment, DraftContent, GAttachmentMeta, GDraft, GLabel, GMessage, GThread, GmailAdapter, LabelWrite, MessageFormat,
} from '@/core/contracts/gmail';
import { ProviderError } from '@/core/errors';
import { gmailUrl } from './endpoints/urls';

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: Part[];
}
interface RawMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  sizeEstimate?: number;
  snippet?: string;
  payload?: Part;
}
interface RawDraft { id: string; message?: RawMessage }
interface RawLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: GLabel['labelListVisibility'];
  messageListVisibility?: GLabel['messageListVisibility'];
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: GLabel['color'];
}

const enc = encodeURIComponent;
const CONCURRENCY = 5;

const PRESETS: Record<string, [string, string]> = {
  BLACK: ['#000000', '#ffffff'], DARK_GRAY: ['#434343', '#ffffff'], GRAY: ['#666666', '#ffffff'], LIGHT_GRAY: ['#cccccc', '#000000'],
  WHITE: ['#ffffff', '#000000'], RED: ['#fb4c2f', '#ffffff'], ORANGE: ['#ffad47', '#000000'], YELLOW: ['#fad165', '#000000'],
  GREEN: ['#16a765', '#ffffff'], MINT: ['#43d692', '#000000'], TEAL: ['#2da2bb', '#ffffff'], BLUE: ['#4a86e8', '#ffffff'],
  PURPLE: ['#a479e2', '#ffffff'], PINK: ['#f691b2', '#000000'], DARK_RED: ['#822111', '#ffffff'], DARK_ORANGE: ['#a46a21', '#ffffff'],
  DARK_GREEN: ['#076239', '#ffffff'], DARK_BLUE: ['#1c4587', '#ffffff'], DARK_PURPLE: ['#41236d', '#ffffff'],
  DARK_PINK: ['#83334c', '#ffffff'], BROWN: ['#7a4706', '#ffffff'],
};

// ---- helpers -------------------------------------------------------------------------------------------------------

async function mapLimit<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

const header = (p: Part | undefined, name: string): string | undefined =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/** Bare addresses from an address-list header ("Ann <a@x.com>, b@y.com" -> ["a@x.com", "b@y.com"]). */
export function parseAddresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = '';
  let addr: string | undefined; // the angle-address, taken only from text outside quotes
  let quoted = false;
  let angle = false;
  let escaped = false;
  const flush = () => {
    const a = (addr ?? cur).trim().replace(/^"|"$/g, '');
    if (a) out.push(a);
    cur = '';
    addr = undefined;
  };
  for (const c of value) {
    if (escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') { angle = true; addr = ''; cur += c; continue; }
    else if (!quoted && c === '>') angle = false;
    else if (angle && !quoted) addr += c;
    if (c === ',' && !quoted && !angle) flush();
    else cur += c;
  }
  flush();
  return out;
}

const decode = (data: string | undefined): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');
const dec = (hex: string): string => (/^[0-9a-f]+$/i.test(hex) ? BigInt(`0x${hex}`).toString() : hex);

interface Flags { subject: boolean; plain: boolean; html: boolean; attach: boolean }
const flagsFor = (f: MessageFormat): Flags => ({
  subject: f !== 'METADATA_ONLY',
  plain: f === 'PLAIN_TEXT' || f === 'FULL_CONTENT',
  html: f === 'FULL_CONTENT',
  attach: f === 'PLAIN_TEXT' || f === 'FULL_CONTENT',
});
const apiFormat = (f: MessageFormat): 'metadata' | 'full' => (flagsFor(f).plain ? 'full' : 'metadata');

interface Content { text?: string; html?: string; attachments: (GAttachmentMeta & { part: Part })[] }
/** shortcut: first text/plain and first text/html win; later alternative parts are ignored. */
function walk(p: Part | undefined, c: Content): Content {
  if (!p) return c;
  if (p.filename) {
    c.attachments.push({ id: p.body?.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body?.size, part: p });
  } else if (p.mimeType === 'text/plain' && c.text === undefined && p.body?.data !== undefined) c.text = decode(p.body.data);
  else if (p.mimeType === 'text/html' && c.html === undefined && p.body?.data !== undefined) c.html = decode(p.body.data);
  for (const child of p.parts ?? []) walk(child, c);
  return c;
}

const wrap76 = (b64: string): string => b64.replace(/\s+/g, '').replace(/(.{76})(?=.)/g, '$1\r\n');
const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
const ascii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-words, split so no word exceeds 75 chars and no multibyte character is cut. */
function encodeSubject(s: string): string {
  const v = clean(s);
  if (ascii(v)) return v;
  const words: string[] = [];
  let cur = '';
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

function textPart(type: string, text: string): string {
  return `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(text).toString('base64'))}`;
}

const boundary = (): string => `sc_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;

function attachmentPart(a: DraftAttachment, i: number): string {
  const name = clean(a.filename ?? `attachment-${i + 1}`);
  const fn = ascii(name) ? `filename="${name.replace(/["\\]/g, '_')}"` : `filename*=UTF-8''${enc(name)}`;
  const type = clean(a.mimeType ?? 'application/octet-stream');
  return [
    `Content-Type: ${type}; name="${ascii(name) ? name.replace(/["\\]/g, '_') : enc(name)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; ${fn}`,
    ...(a.inline ? [`Content-ID: <${i + 1}.${boundary()}@sc>`] : []),
    '',
    wrap76(a.content),
  ].join('\r\n');
}

interface Mime extends DraftContent { inReplyTo?: string; references?: string }
export function buildMime(m: Mime): string {
  const alt = boundary();
  const mixed = boundary();
  let body: string;
  if (m.body !== undefined && m.htmlBody !== undefined) {
    body = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart('text/plain', m.body)}\r\n--${alt}\r\n${textPart('text/html', m.htmlBody)}\r\n--${alt}--`;
  } else if (m.htmlBody !== undefined) body = textPart('text/html', m.htmlBody);
  else body = textPart('text/plain', m.body ?? '');
  const atts = m.attachments ?? [];
  const list = (a: string[] | undefined) => (a ?? []).map(clean).join(', ');
  const head = [
    'MIME-Version: 1.0',
    ...(m.to?.length ? [`To: ${list(m.to)}`] : []),
    ...(m.cc?.length ? [`Cc: ${list(m.cc)}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${list(m.bcc)}`] : []),
    ...(m.subject !== undefined ? [`Subject: ${encodeSubject(m.subject)}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${clean(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${clean(m.references)}`] : []),
  ];
  if (atts.length === 0) return `${head.join('\r\n')}\r\n${body}\r\n`;
  const parts = atts.map((a, i) => `--${mixed}\r\n${attachmentPart(a, i)}`).join('\r\n');
  return `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${body}\r\n${parts}\r\n--${mixed}--\r\n`;
}

const notFoundToNull = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'not_found') return null;
    throw e;
  }
};

// ---- adapter -------------------------------------------------------------------------------------------------------

export function createLiveGmailAdapter(ctx: AdapterContext): GmailAdapter {
  const { http } = ctx;
  const email = ctx.account.email;
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    http.json<T>({ method: 'GET', url: gmailUrl(`/users/me${path}`), query });
  const send = <T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown) =>
    http.json<T>({ method, url: gmailUrl(`/users/me${path}`), body });

  const threadUrl = (tid: string) => `https://mail.google.com/mail/?authuser=${email}#all/thread-f:${dec(tid)}`;

  function mapMessage(r: RawMessage, f: MessageFormat): GMessage {
    const fl = flagsFor(f);
    const h = r.payload;
    const internalDate = r.internalDate ?? '0';
    const m: GMessage = {
      id: r.id,
      threadId: r.threadId,
      historyId: r.historyId,
      internalDate,
      date: new Date(Number(internalDate)).toISOString(),
      sender: parseAddresses(header(h, 'From'))[0],
      toRecipients: parseAddresses(header(h, 'To')),
      ccRecipients: parseAddresses(header(h, 'Cc')),
      bccRecipients: parseAddresses(header(h, 'Bcc')),
      labelIds: r.labelIds,
      sizeEstimate: r.sizeEstimate,
      viewUrl: `${threadUrl(r.threadId)}|msg-f:${dec(r.id)}`,
    };
    if (fl.subject) {
      m.subject = header(h, 'Subject') ?? '';
      m.snippet = r.snippet ?? '';
    }
    if (fl.plain) {
      const c = walk(h, { attachments: [] });
      m.plaintextBody = c.text ?? '';
      if (fl.html && c.html !== undefined) m.htmlBody = c.html;
      m.attachmentIds = c.attachments.flatMap((a) => (a.id ? [a.id] : []));
      m.attachments = c.attachments.map(({ part: _p, ...meta }) => meta);
    }
    return m;
  }

  const mapThread = (r: { id: string; messages?: RawMessage[] }, f: MessageFormat): GThread => {
    const messages = (r.messages ?? []).map((x) => mapMessage(x, f));
    return { id: r.id, messageCount: messages.length, messages, viewUrl: threadUrl(r.id) };
  };

  function mapDraft(r: RawDraft, f: MessageFormat | null): GDraft {
    const msg = r.message ?? { id: '', threadId: '' };
    const fl = flagsFor(f ?? 'METADATA_ONLY');
    const m = mapMessage(msg, f ?? 'METADATA_ONLY');
    const d: GDraft = {
      id: r.id,
      messageId: msg.id,
      threadId: msg.threadId,
      date: msg.internalDate ? m.date : undefined,
      sender: m.sender,
      toRecipients: m.toRecipients,
      ccRecipients: m.ccRecipients,
      bccRecipients: m.bccRecipients,
      labelIds: msg.labelIds,
      viewUrl: `https://mail.google.com/mail/?authuser=${email}#all?compose=thread-f:${dec(msg.threadId)}%2Bmsg-a:${r.id}`,
    };
    if (fl.subject) d.subject = m.subject;
    if (fl.plain) d.plaintextBody = m.plaintextBody;
    return d;
  }

  const mapLabel = (r: RawLabel): GLabel => ({
    labelId: r.id,
    name: r.name,
    labelType: r.type === 'system' ? 'SYSTEM' : 'USER',
    labelListVisibility: r.labelListVisibility,
    messageListVisibility: r.messageListVisibility,
    messagesTotal: r.messagesTotal,
    messagesUnread: r.messagesUnread,
    threadsTotal: r.threadsTotal,
    threadsUnread: r.threadsUnread,
    color: r.color,
  });

  const labelBody = (p: LabelWrite, name?: string) => {
    const preset = p.colorPreset ? PRESETS[p.colorPreset.toUpperCase().replace(/^LABEL_COLOR_PRESET_/, '')] : undefined;
    if (p.colorPreset && !preset) throw new ProviderError('upstream_error', 'Unknown colorPreset');
    return {
      name,
      labelListVisibility: p.labelListVisibility,
      messageListVisibility: p.messageListVisibility,
      color: preset ? { backgroundColor: preset[0], textColor: preset[1] } : undefined,
    };
  };

  const fetchMessage = (id: string, f: MessageFormat) => get<RawMessage>(`/messages/${enc(id)}`, { format: apiFormat(f) });
  const fetchThread = (id: string, f: MessageFormat) => get<{ id: string; messages?: RawMessage[] }>(`/threads/${enc(id)}`, { format: apiFormat(f) });
  const fetchDraft = (id: string, f: MessageFormat) => get<RawDraft>(`/drafts/${enc(id)}`, { format: apiFormat(f) });

  async function saveDraft(c: Mime & { threadId?: string }, draftId?: string): Promise<GDraft> {
    const message = { raw: Buffer.from(buildMime(c)).toString('base64url'), ...(c.threadId ? { threadId: c.threadId } : {}) };
    const r = draftId
      ? await send<RawDraft>('PUT', `/drafts/${enc(draftId)}`, { id: draftId, message })
      : await send<RawDraft>('POST', '/drafts', { message });
    return mapDraft(r, null);
  }

  return {
    async searchThreads(p) {
      const list = await get<{ threads?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>('/threads', {
        q: p.q, maxResults: p.pageSize, pageToken: p.pageToken, includeSpamTrash: p.includeTrash ? true : undefined,
      });
      const items = await mapLimit(list.threads ?? [], async (t) => mapThread(await fetchThread(t.id, p.view), p.view));
      return { items, nextPageToken: list.nextPageToken, resultSizeEstimate: list.resultSizeEstimate } satisfies Page<GThread> & { resultSizeEstimate?: number };
    },

    async getThread(p) {
      const r = await notFoundToNull(fetchThread(p.threadId, p.format));
      return r && mapThread(r, p.format);
    },

    async getMessage(p) {
      const r = await notFoundToNull(fetchMessage(p.messageId, p.format));
      return r && mapMessage(r, p.format);
    },

    async listDrafts(p) {
      const list = await get<{ drafts?: { id: string }[]; nextPageToken?: string }>('/drafts', { q: p.q, maxResults: p.pageSize, pageToken: p.pageToken });
      const f: MessageFormat = p.full ? 'PLAIN_TEXT' : 'METADATA_ONLY';
      const items = await mapLimit(list.drafts ?? [], async (d) => mapDraft(await fetchDraft(d.id, f), f));
      return { items, nextPageToken: list.nextPageToken };
    },

    async getDraft(p) {
      const r = await notFoundToNull(fetchDraft(p.draftId, p.format));
      return r && mapDraft(r, p.format);
    },

    async createDraft(p) {
      const { replyToMessageId, ...content } = p;
      if (!replyToMessageId) return saveDraft(content);
      const orig = await fetchMessage(replyToMessageId, 'MINIMAL');
      const id = header(orig.payload, 'Message-ID') ?? header(orig.payload, 'Message-Id');
      const refs = header(orig.payload, 'References');
      const subj = header(orig.payload, 'Subject') ?? '';
      const from = parseAddresses(header(orig.payload, 'From'));
      return saveDraft({
        ...content,
        to: content.to?.length ? content.to : from,
        subject: content.subject ?? (/^re:/i.test(subj) ? subj : `Re: ${subj}`),
        inReplyTo: id,
        references: [refs, id].filter(Boolean).join(' ') || undefined,
        threadId: orig.threadId,
      });
    },

    async updateDraft(p) {
      const { draftId, ...patch } = p;
      const cur = await fetchDraft(draftId, 'FULL_CONTENT');
      const msg = cur.message;
      const c = walk(msg?.payload, { attachments: [] });
      let attachments = patch.attachments;
      if (!attachments) {
        // Existing attachments must be re-sent in the PUT, so their bytes are fetched.
        attachments = await mapLimit(c.attachments, async (a) => {
          const data = a.part.body?.data ?? (a.id ? (await get<{ data?: string }>(`/messages/${enc(msg?.id ?? '')}/attachments/${enc(a.id)}`)).data : undefined);
          return { content: Buffer.from(data ?? '', 'base64url').toString('base64'), filename: a.filename, mimeType: a.mimeType };
        });
      }
      const h = msg?.payload;
      return saveDraft(
        {
          to: patch.to ?? parseAddresses(header(h, 'To')),
          cc: patch.cc ?? parseAddresses(header(h, 'Cc')),
          bcc: patch.bcc ?? parseAddresses(header(h, 'Bcc')),
          subject: patch.subject ?? header(h, 'Subject'),
          body: patch.body ?? c.text,
          htmlBody: patch.htmlBody ?? c.html,
          attachments,
          inReplyTo: header(h, 'In-Reply-To'),
          references: header(h, 'References'),
          threadId: msg?.threadId,
        },
        draftId,
      );
    },

    async listLabels() {
      const { labels = [] } = await get<{ labels?: RawLabel[] }>('/labels');
      // labels.list has no counts; each label is fetched for them.
      return mapLimit(labels, async (l) => mapLabel(await get<RawLabel>(`/labels/${enc(l.id)}`)));
    },

    async createLabel(p) {
      const parts = p.displayName.split('/');
      if ((p.autoCreateParentLabels ?? true) && parts.length > 1) {
        const { labels = [] } = await get<{ labels?: RawLabel[] }>('/labels');
        const have = new Set(labels.map((l) => l.name));
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          if (!have.has(parent)) await send<RawLabel>('POST', '/labels', { name: parent });
        }
      }
      return mapLabel(await send<RawLabel>('POST', '/labels', labelBody(p, p.displayName)));
    },

    async updateLabel(p) {
      return mapLabel(await send<RawLabel>('PATCH', `/labels/${enc(p.labelId)}`, labelBody(p, p.displayName)));
    },

    async modifyMessage(p) {
      await send('POST', `/messages/${enc(p.messageId)}/modify`, { addLabelIds: p.add, removeLabelIds: p.remove });
      return mapMessage(await fetchMessage(p.messageId, 'METADATA_ONLY'), 'METADATA_ONLY');
    },

    async modifyThread(p) {
      await send('POST', `/threads/${enc(p.threadId)}/modify`, { addLabelIds: p.add, removeLabelIds: p.remove });
      return mapThread(await fetchThread(p.threadId, 'METADATA_ONLY'), 'METADATA_ONLY');
    },
  };
}
