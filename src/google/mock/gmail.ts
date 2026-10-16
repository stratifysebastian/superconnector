import type { AdapterContext } from '@/core/contracts/adapter';
import type {
  DraftContent,
  GAttachmentMeta,
  GDraft,
  GLabel,
  GMessage,
  GThread,
  GmailAdapter,
  MessageFormat,
} from '@/core/contracts/gmail';
import type { Page } from '@/core/contracts/calendar';
import { GuardrailError, ProviderError } from '@/core/errors';
import { loadFixture } from './fixtures';
import { withMockFaults } from './faults';

/** Stored message: GMessage fields at full detail, plus the RFC822 headers replies need. */
interface Msg {
  id: string;
  threadId: string;
  internalDate: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  labelIds: string[];
  subject?: string;
  snippet?: string;
  plaintextBody?: string;
  htmlBody?: string;
  attachments?: GAttachmentMeta[];
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string;
}
interface Draft extends Msg {
  draftId: string;
}
interface State {
  messages: Msg[];
  drafts: Draft[];
  labels: GLabel[];
  counter: number;
}

const states = new Map<string, State>();

export function resetMockGmail(): void {
  states.clear();
}

function stateFor(label: string): State {
  let s = states.get(label);
  if (!s) {
    const clone = <T>(v: T): T => structuredClone(v);
    s = {
      messages: clone(loadFixture<{ messages: Msg[] }>('gmail', label, 'messages').messages),
      drafts: clone(loadFixture<{ drafts: (Msg & { id: string; messageId: string })[] }>('gmail', label, 'drafts').drafts).map((d) => ({
        ...d,
        draftId: d.id,
        id: d.messageId,
        labelIds: ['DRAFT'],
      })),
      labels: clone(loadFixture<{ labels: GLabel[] }>('gmail', label, 'labels').labels),
      counter: 0,
    };
    states.set(label, s);
  }
  return s;
}

const dec = (hex: string): string => BigInt(`0x${hex}`).toString();
const iso = (ms: string): string => new Date(Number(ms)).toISOString().replace('.000', '');
const base = (email: string): string => `https://mail.google.com/mail/?authuser=${email}`;

function toMessage(m: Msg, format: MessageFormat, email: string): GMessage {
  const out: GMessage = {
    id: m.id,
    threadId: m.threadId,
    historyId: String(1000 + Number(m.id.slice(-4).replace(/\D/g, '') || 0)),
    internalDate: m.internalDate,
    date: iso(m.internalDate),
    ...(m.sender ? { sender: m.sender } : {}),
    toRecipients: m.toRecipients ?? [],
    ...(m.ccRecipients ? { ccRecipients: m.ccRecipients } : {}),
    ...(m.bccRecipients ? { bccRecipients: m.bccRecipients } : {}),
    labelIds: [...m.labelIds],
    sizeEstimate: 1024 + (m.plaintextBody?.length ?? 0),
    viewUrl: `${base(email)}#all/thread-f:${dec(m.threadId)}|msg-f:${dec(m.id)}`,
  };
  if (format === 'METADATA_ONLY') return out;
  if (m.subject !== undefined) out.subject = m.subject;
  if (m.snippet !== undefined) out.snippet = m.snippet;
  if (format === 'MINIMAL') return out;
  if (m.plaintextBody !== undefined) out.plaintextBody = m.plaintextBody;
  out.attachments = m.attachments ?? [];
  out.attachmentIds = out.attachments.flatMap((a) => (a.id ? [a.id] : []));
  if (format === 'FULL_CONTENT' && m.htmlBody !== undefined) out.htmlBody = m.htmlBody;
  return out;
}

function toThread(s: State, threadId: string, format: MessageFormat, email: string): GThread | null {
  const ms = s.messages.filter((m) => m.threadId === threadId).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  if (!ms.length) return null;
  return {
    id: threadId,
    messageCount: ms.length,
    messages: ms.map((m) => toMessage(m, format, email)),
    viewUrl: `${base(email)}#all/thread-f:${dec(threadId)}`,
  };
}

function toDraft(d: Draft, format: MessageFormat | 'FULL', email: string, sender: string): GDraft {
  const out: GDraft = {
    id: d.draftId,
    messageId: d.id,
    threadId: d.threadId,
    date: iso(d.internalDate),
    sender,
    toRecipients: d.toRecipients ?? [],
    ...(d.ccRecipients?.length ? { ccRecipients: d.ccRecipients } : {}),
    ...(d.bccRecipients?.length ? { bccRecipients: d.bccRecipients } : {}),
    labelIds: ['DRAFT'],
    viewUrl: `${base(email)}#all?compose=thread-f:${dec(d.threadId)}%2Bmsg-a:${d.draftId}`,
  };
  if (format !== 'METADATA_ONLY') {
    if (d.subject !== undefined) out.subject = d.subject;
    if (d.plaintextBody !== undefined) out.plaintextBody = d.plaintextBody;
  }
  return out;
}

/** shortcut: tokens split on whitespace, no quotes, no negation or OR. Enough for the mock. */
function matcher(q: string | undefined, s: State): { test: (m: Msg) => boolean; spam: boolean } {
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const labelIds = (name: string): string[] =>
    s.labels.filter((l) => l.labelId.toLowerCase() === name || l.name.toLowerCase() === name).map((l) => l.labelId);
  let spam = false;
  const tests: ((m: Msg) => boolean)[] = [];
  for (const t of terms) {
    const [k, ...rest] = t.split(':');
    const v = rest.join(':');
    if (rest.length && k === 'from') tests.push((m) => (m.sender ?? '').toLowerCase().includes(v));
    else if (rest.length && k === 'subject') tests.push((m) => (m.subject ?? '').toLowerCase().includes(v));
    else if (rest.length && k === 'label') tests.push((m) => labelIds(v).some((id) => m.labelIds.includes(id)));
    else if (t === 'in:spam') {
      spam = true;
      tests.push((m) => m.labelIds.includes('SPAM'));
    }
    else if (t === 'in:inbox') tests.push((m) => m.labelIds.includes('INBOX'));
    else if (t === 'is:unread') tests.push((m) => m.labelIds.includes('UNREAD'));
    else tests.push((m) => [m.sender, m.subject, m.snippet, m.plaintextBody].some((x) => x?.toLowerCase().includes(t)));
  }
  return { test: (m) => tests.every((f) => f(m)), spam };
}

/** pageToken is the string offset. */
function paginate<T>(all: T[], pageSize: number, pageToken?: string): Page<T> {
  const offset = pageToken ? Number.parseInt(pageToken, 10) || 0 : 0;
  const items = all.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  return next < all.length ? { items, nextPageToken: String(next) } : { items };
}

const hex = (s: State, prefix: number): string => (BigInt(prefix) * 0x100000000n + BigInt(++s.counter) + 0xf000n).toString(16);

export function createMockGmailAdapter(ctx: AdapterContext): GmailAdapter {
  const { label, email } = ctx.account;
  const s = (): State => stateFor(label);
  const run = <T>(fn: () => T): Promise<T> => withMockFaults(ctx.account, fn, { signal: ctx.signal });
  const mockPrefix = label === 'prime' ? 0x1b00 : 0x1a00;

  const applyDraft = (d: Draft, p: DraftContent): void => {
    if (p.to) d.toRecipients = p.to;
    if (p.cc) d.ccRecipients = p.cc;
    if (p.bcc) d.bccRecipients = p.bcc;
    if (p.subject !== undefined) d.subject = p.subject;
    if (p.body !== undefined) {
      d.plaintextBody = p.body;
      d.snippet = p.body.slice(0, 80);
    }
    if (p.htmlBody !== undefined) d.htmlBody = p.htmlBody;
    if (p.attachments)
      d.attachments = p.attachments.map((a, i) => ({
        id: `att-${d.draftId}-${i + 1}`,
        ...(a.filename ? { filename: a.filename } : {}),
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
        size: Math.floor((a.content.length * 3) / 4),
      }));
    d.internalDate = String(Date.now());
  };

  const checkLabels = (add?: string[], remove?: string[]): void => {
    if ([...(add ?? []), ...(remove ?? [])].includes('TRASH'))
      throw new GuardrailError('gmail_no_trash', 'The TRASH label cannot be added or removed (this also blocks untrash).');
  };
  const edit = (ids: string[], add?: string[], remove?: string[]): void => {
    const st = s();
    for (const m of st.messages)
      if (ids.includes(m.id)) m.labelIds = [...new Set([...m.labelIds, ...(add ?? [])])].filter((l) => !(remove ?? []).includes(l));
  };

  return {
    searchThreads: (p) =>
      run(() => {
        const st = s();
        const { test, spam } = matcher(p.q, st);
        const visible = st.messages.filter(
          (m) => (spam || !m.labelIds.includes('SPAM')) && (p.includeTrash || !m.labelIds.includes('TRASH')) && test(m),
        );
        const latest = new Map<string, number>();
        for (const m of visible) latest.set(m.threadId, Math.max(latest.get(m.threadId) ?? 0, Number(m.internalDate)));
        const ids = [...latest.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
        const page = paginate(ids, p.pageSize, p.pageToken);
        return {
          items: page.items.map((id) => toThread(st, id, p.view, email)!),
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          resultSizeEstimate: ids.length,
        };
      }),

    getThread: ({ threadId, format }) => run(() => toThread(s(), threadId, format, email)),

    getMessage: ({ messageId, format }) =>
      run(() => {
        const m = s().messages.find((x) => x.id === messageId);
        return m ? toMessage(m, format, email) : null;
      }),

    listDrafts: (p) =>
      run(() => {
        const q = p.q?.toLowerCase();
        const all = s()
          .drafts.filter((d) => !q || [d.subject, d.plaintextBody, ...(d.toRecipients ?? [])].some((x) => x?.toLowerCase().includes(q)))
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        const page = paginate(all, p.pageSize, p.pageToken);
        return { ...page, items: page.items.map((d) => toDraft(d, p.full ? 'FULL' : 'METADATA_ONLY', email, email)) };
      }),

    getDraft: ({ draftId, format }) =>
      run(() => {
        const d = s().drafts.find((x) => x.draftId === draftId);
        return d ? toDraft(d, format, email, email) : null;
      }),

    createDraft: ({ replyToMessageId, ...content }) =>
      run(() => {
        const st = s();
        const orig = replyToMessageId ? st.messages.find((m) => m.id === replyToMessageId) : undefined;
        if (replyToMessageId && !orig) throw new ProviderError('not_found', 'Message to reply to not found');
        const id = hex(st, mockPrefix);
        const d: Draft = {
          id,
          draftId: `r-${dec(id)}`,
          threadId: orig?.threadId ?? id,
          internalDate: String(Date.now()),
          labelIds: ['DRAFT'],
          sender: email,
          toRecipients: orig && !content.to ? [orig.sender ?? ''] : [],
          ...(orig?.subject ? { subject: /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}` } : {}),
          ...(orig?.rfcMessageId
            ? { inReplyTo: orig.rfcMessageId, references: [orig.references, orig.rfcMessageId].filter(Boolean).join(' ') }
            : {}),
        };
        applyDraft(d, content);
        st.drafts.push(d);
        return toDraft(d, 'FULL', email, email);
      }),

    updateDraft: ({ draftId, ...content }) =>
      run(() => {
        const d = s().drafts.find((x) => x.draftId === draftId);
        if (!d) throw new ProviderError('not_found', 'Draft not found');
        applyDraft(d, content);
        return toDraft(d, 'FULL', email, email);
      }),

    listLabels: () =>
      run(() => {
        const st = s();
        return st.labels.map((l) => {
          const ms = st.messages.filter((m) => m.labelIds.includes(l.labelId));
          const threads = (pred: (m: Msg) => boolean): number => new Set(ms.filter(pred).map((m) => m.threadId)).size;
          const unread = (m: Msg): boolean => m.labelIds.includes('UNREAD');
          return {
            ...l,
            messagesTotal: ms.length,
            messagesUnread: ms.filter(unread).length,
            threadsTotal: threads(() => true),
            threadsUnread: threads(unread),
          };
        });
      }),

    createLabel: ({ displayName, autoCreateParentLabels, ...rest }) =>
      run(() => {
        const st = s();
        if (st.labels.some((l) => l.name.toLowerCase() === displayName.toLowerCase()))
          throw new ProviderError('upstream_error', 'Label name exists or conflicts', 409);
        const parts = displayName.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          if (st.labels.some((l) => l.name === parent)) continue;
          if (autoCreateParentLabels === false) throw new ProviderError('not_found', 'Parent label does not exist');
          st.labels.push({ labelId: `Label_${100 + ++st.counter}`, name: parent, labelType: 'USER', labelListVisibility: 'LABEL_SHOW', messageListVisibility: 'SHOW' });
        }
        const created: GLabel = {
          labelId: `Label_${100 + ++st.counter}`,
          name: displayName,
          labelType: 'USER',
          labelListVisibility: rest.labelListVisibility ?? 'LABEL_SHOW',
          messageListVisibility: rest.messageListVisibility ?? 'SHOW',
          ...(rest.colorPreset ? { colorPreset: rest.colorPreset } : {}),
        };
        st.labels.push(created);
        return created;
      }),

    updateLabel: ({ labelId, displayName, ...rest }) =>
      run(() => {
        const l = s().labels.find((x) => x.labelId === labelId);
        if (!l) throw new ProviderError('not_found', 'Label not found');
        if (l.labelType === 'SYSTEM') throw new ProviderError('upstream_error', 'System labels cannot be modified', 400);
        if (displayName !== undefined) l.name = displayName;
        if (rest.labelListVisibility) l.labelListVisibility = rest.labelListVisibility;
        if (rest.messageListVisibility) l.messageListVisibility = rest.messageListVisibility;
        if (rest.colorPreset) l.colorPreset = rest.colorPreset;
        return { ...l };
      }),

    modifyMessage: ({ messageId, add, remove }) =>
      run(() => {
        checkLabels(add, remove);
        const m = s().messages.find((x) => x.id === messageId);
        if (!m) throw new ProviderError('not_found', 'Message not found');
        edit([messageId], add, remove);
        return toMessage(m, 'METADATA_ONLY', email);
      }),

    modifyThread: ({ threadId, add, remove }) =>
      run(() => {
        checkLabels(add, remove);
        const st = s();
        edit(st.messages.filter((m) => m.threadId === threadId).map((m) => m.id), add, remove);
        const t = toThread(st, threadId, 'METADATA_ONLY', email);
        if (!t) throw new ProviderError('not_found', 'Thread not found');
        return t;
      }),
  };
}
