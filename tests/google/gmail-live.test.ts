import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '@/core/contracts/adapter';
import { GuardrailError } from '@/core/errors';
import { ENDPOINT_RULES } from '@/google/endpoints';
import { createGoogleHttp } from '@/google/http';
import { createLiveGmailAdapter, parseAddresses } from '@/google/gmail';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const q = (u: URL) => Object.fromEntries(u.searchParams);

type Call = { url: URL; method: string; body?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (c: Call) => Response | undefined;

function setup(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { url: new URL(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c) ?? json({});
  }) as unknown as typeof fetch;
  const http = createGoogleHttp({ getAccessToken: async () => 'tok', fetchImpl, rules: ENDPOINT_RULES, sleep: async () => {} });
  const ctx = { http, account: { email: 'me@x.com' } } as unknown as AdapterContext;
  return { http, adapter: createLiveGmailAdapter(ctx), calls };
}

const hdr = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const rawMsg = (over: Record<string, unknown> = {}) => ({
  id: '1a', threadId: '2b', historyId: '9', internalDate: '1700000000000', labelIds: ['INBOX'], sizeEstimate: 10, snippet: 'snip',
  payload: {
    mimeType: 'multipart/mixed',
    headers: hdr({ From: '"Doe, Ann" <ann@x.com>', To: 'Bob <bob@x.com>, c@x.com', Cc: 'd@x.com', Subject: 'Hello', 'Message-ID': '<m1@x>', References: '<m0@x>' }),
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64('plain body') } },
        { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
      ] },
      { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att1', size: 5 } },
    ],
  },
  ...over,
});
const decodeRaw = (c: Call) => Buffer.from(c.body.message.raw, 'base64url').toString();
const bodyOf = (mime: string, type: string) => {
  const m = new RegExp(`Content-Type: ${type}; charset="UTF-8"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]*?)(?:\\r\\n--|\\r\\n$)`).exec(mime);
  return Buffer.from((m?.[1] ?? '').replace(/\s/g, ''), 'base64').toString();
};

describe('parseAddresses', () => {
  it('returns bare addresses', () => {
    expect(parseAddresses('"Doe, Ann" <ann@x.com>, Bob <bob@x.com>, c@x.com')).toEqual(['ann@x.com', 'bob@x.com', 'c@x.com']);
    expect(parseAddresses(undefined)).toEqual([]);
  });
});

describe('reads', () => {
  it('getMessage maps shape and viewUrl per format; 404 is null', async () => {
    const { adapter, calls } = setup((c) => (c.url.pathname.endsWith('/gone') ? json({}, 404) : json(rawMsg())));
    const full = await adapter.getMessage({ messageId: '1a', format: 'FULL_CONTENT' });
    expect(calls[0]!.url.pathname).toBe('/gmail/v1/users/me/messages/1a');
    expect(q(calls[0]!.url)).toEqual({ format: 'full' });
    expect(full).toEqual({
      id: '1a', threadId: '2b', historyId: '9', internalDate: '1700000000000', date: '2023-11-14T22:13:20.000Z',
      sender: 'ann@x.com', toRecipients: ['bob@x.com', 'c@x.com'], ccRecipients: ['d@x.com'], bccRecipients: [], labelIds: ['INBOX'], sizeEstimate: 10,
      viewUrl: 'https://mail.google.com/mail/?authuser=me@x.com#all/thread-f:43|msg-f:26',
      subject: 'Hello', snippet: 'snip', plaintextBody: 'plain body', htmlBody: '<p>html</p>',
      attachmentIds: ['att1'], attachments: [{ id: 'att1', filename: 'a.pdf', mimeType: 'application/pdf', size: 5 }],
    });
    const plain = await adapter.getMessage({ messageId: '1a', format: 'PLAIN_TEXT' });
    expect(plain!.htmlBody).toBeUndefined();
    expect(plain!.plaintextBody).toBe('plain body');
    const meta = await adapter.getMessage({ messageId: '1a', format: 'METADATA_ONLY' });
    expect(q(calls[2]!.url)).toEqual({ format: 'metadata' });
    expect(meta!.subject).toBeUndefined();
    expect(meta!.plaintextBody).toBeUndefined();
    const min = await adapter.getMessage({ messageId: '1a', format: 'MINIMAL' });
    expect(q(calls[3]!.url)).toEqual({ format: 'metadata' });
    expect(min!.subject).toBe('Hello');
    expect(min!.snippet).toBe('snip');
    expect(await adapter.getMessage({ messageId: 'gone', format: 'MINIMAL' })).toBeNull();
  });

  it('searchThreads lists then fetches metadata in list order, includeSpamTrash only when asked', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const { adapter, calls } = setup((c) => {
      if (c.url.pathname.endsWith('/threads')) return json({ threads: ids.map((id) => ({ id })), nextPageToken: 'n', resultSizeEstimate: 12 });
      return json({ id: c.url.pathname.split('/').pop(), messages: [] });
    });
    const out = await adapter.searchThreads({ q: 'in:inbox', pageSize: 12, pageToken: 'p', view: 'METADATA_ONLY' });
    expect(calls[0]!.method).toBe('GET');
    expect(q(calls[0]!.url)).toEqual({ q: 'in:inbox', maxResults: '12', pageToken: 'p' });
    expect(calls.slice(1).map((c) => c.url.pathname.split('/').pop())).toEqual(ids);
    expect(calls.slice(1).every((c) => q(c.url).format === 'metadata')).toBe(true);
    expect(out.items.map((t) => t.id)).toEqual(ids);
    expect(out.nextPageToken).toBe('n');
    expect(out.resultSizeEstimate).toBe(12);

    const t = setup((c) => (c.url.pathname.endsWith('/threads') ? json({ threads: [{ id: 'aa' }] }) : json({ id: 'aa', messages: [rawMsg()] })));
    const r = await t.adapter.searchThreads({ pageSize: 1, includeTrash: true, view: 'MINIMAL' });
    expect(q(t.calls[0]!.url)).toEqual({ maxResults: '1', includeSpamTrash: 'true' });
    expect(r.items[0]).toMatchObject({ id: 'aa', messageCount: 1, viewUrl: 'https://mail.google.com/mail/?authuser=me@x.com#all/thread-f:170' });
    expect(r.items[0]!.messages[0]!.subject).toBe('Hello');
  });

  it('searchThreads never has more than 5 fetches in flight', async () => {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname.endsWith('/threads')) return json({ threads: Array.from({ length: 12 }, (_, i) => ({ id: `${i}` })) });
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({ id: 'x', messages: [] });
    }) as unknown as typeof fetch;
    const http = createGoogleHttp({ getAccessToken: async () => 't', fetchImpl, rules: ENDPOINT_RULES, sleep: async () => {} });
    const a = createLiveGmailAdapter({ http, account: { email: 'me@x.com' } } as unknown as AdapterContext);
    await a.searchThreads({ pageSize: 12, view: 'MINIMAL' });
    expect(peak).toBe(5);
  });

  it('drafts: list fetches each draft; get maps the draft shape and viewUrl', async () => {
    const draft = { id: 'r-77', message: rawMsg({ id: '1a', threadId: '2b', labelIds: ['DRAFT'] }) };
    const { adapter, calls } = setup((c) => (c.url.pathname.endsWith('/drafts') ? json({ drafts: [{ id: 'r-77' }], nextPageToken: 'n' }) : json(draft)));
    const page = await adapter.listDrafts({ q: 'x', pageSize: 3, full: true });
    expect(q(calls[0]!.url)).toEqual({ q: 'x', maxResults: '3' });
    expect(q(calls[1]!.url)).toEqual({ format: 'full' });
    expect(page.nextPageToken).toBe('n');
    expect(page.items[0]).toMatchObject({
      id: 'r-77', messageId: '1a', threadId: '2b', sender: 'ann@x.com', subject: 'Hello', plaintextBody: 'plain body', labelIds: ['DRAFT'],
      viewUrl: 'https://mail.google.com/mail/?authuser=me@x.com#all?compose=thread-f:43%2Bmsg-a:r-77',
    });
    const g = await adapter.getDraft({ draftId: 'r-77', format: 'METADATA_ONLY' });
    expect(g!.subject).toBeUndefined();
    expect(q(calls[2]!.url)).toEqual({ format: 'metadata' });
  });

  it('listLabels fetches each label for counts', async () => {
    const { adapter, calls } = setup((c) => {
      if (c.url.pathname.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'A/B', type: 'user' }] });
      const id = c.url.pathname.split('/').pop()!;
      return json({ id, name: id === 'INBOX' ? 'INBOX' : 'A/B', type: id === 'INBOX' ? 'system' : 'user', messagesTotal: 5, messagesUnread: 1, threadsTotal: 4, threadsUnread: 1, color: { backgroundColor: '#000000', textColor: '#ffffff' } });
    });
    const labels = await adapter.listLabels();
    expect(calls.map((c) => c.url.pathname)).toEqual(['/gmail/v1/users/me/labels', '/gmail/v1/users/me/labels/INBOX', '/gmail/v1/users/me/labels/Label_1']);
    expect(labels).toEqual([
      { labelId: 'INBOX', name: 'INBOX', labelType: 'SYSTEM', messagesTotal: 5, messagesUnread: 1, threadsTotal: 4, threadsUnread: 1, color: { backgroundColor: '#000000', textColor: '#ffffff' } },
      { labelId: 'Label_1', name: 'A/B', labelType: 'USER', messagesTotal: 5, messagesUnread: 1, threadsTotal: 4, threadsUnread: 1, color: { backgroundColor: '#000000', textColor: '#ffffff' } },
    ]);
  });
});

describe('drafts', () => {
  it('createDraft: plain text, UTF-8 subject, alternative and attachments', async () => {
    const { adapter, calls } = setup((c) => (c.method === 'POST' ? json({ id: 'r-1', message: { id: 'm', threadId: 'ab' } }) : undefined));
    const d = await adapter.createDraft({ to: ['a@x.com'], cc: ['b@x.com'], subject: 'Grüße ✓', body: 'hi' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/gmail/v1/users/me/drafts');
    expect(Object.keys(calls[0]!.body)).toEqual(['message']);
    expect(Object.keys(calls[0]!.body.message)).toEqual(['raw']);
    const mime = decodeRaw(calls[0]!);
    expect(mime).toContain('To: a@x.com\r\nCc: b@x.com\r\n');
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    const subj = /Subject: (.*)\r\n/.exec(mime)![1]!;
    expect(Buffer.from(subj.replace(/=\?UTF-8\?B\?|\?=/g, ''), 'base64').toString()).toBe('Grüße ✓');
    expect(bodyOf(mime, 'text/plain')).toBe('hi');
    expect(d).toMatchObject({ id: 'r-1', threadId: 'ab', messageId: 'm' });

    await adapter.createDraft({ to: ['a@x.com'], subject: 's', body: 'plain', htmlBody: '<b>h</b>' });
    const alt = decodeRaw(calls[1]!);
    expect(alt).toContain('Content-Type: multipart/alternative;');
    expect(bodyOf(alt, 'text/plain')).toBe('plain');
    expect(bodyOf(alt, 'text/html')).toBe('<b>h</b>');

    await adapter.createDraft({ to: ['a@x.com'], subject: 's', body: 'x', attachments: [{ content: Buffer.from('FILE').toString('base64'), filename: 'f.txt', mimeType: 'text/plain' }] });
    const mixed = decodeRaw(calls[2]!);
    expect(mixed).toContain('Content-Type: multipart/mixed;');
    expect(mixed).toContain('Content-Disposition: attachment; filename="f.txt"');
    expect(mixed).toContain(Buffer.from('FILE').toString('base64'));
  });

  it('reply sets threadId, In-Reply-To, References, Re: subject and defaults To to the sender', async () => {
    const { adapter, calls } = setup((c) => (c.method === 'GET' ? json(rawMsg()) : json({ id: 'r-2', message: { id: 'm', threadId: '2b' } })));
    await adapter.createDraft({ replyToMessageId: '1a', body: 'thanks' });
    expect(calls[0]!.url.pathname).toBe('/gmail/v1/users/me/messages/1a');
    expect(q(calls[0]!.url)).toEqual({ format: 'metadata' });
    expect(calls[1]!.body.message.threadId).toBe('2b');
    const mime = decodeRaw(calls[1]!);
    expect(mime).toContain('To: ann@x.com\r\n');
    expect(mime).toContain('Subject: Re: Hello\r\n');
    expect(mime).toContain('In-Reply-To: <m1@x>\r\n');
    expect(mime).toContain('References: <m0@x> <m1@x>\r\n');
    expect(mime).not.toContain('plain body');

    await adapter.createDraft({ replyToMessageId: '1a', to: ['z@x.com'], subject: 'Custom', body: 'b' });
    const m2 = decodeRaw(calls[3]!);
    expect(m2).toContain('To: z@x.com\r\n');
    expect(m2).toContain('Subject: Custom\r\n');
  });

  it('updateDraft merges: provided fields replace, omitted keep, attachments kept by fetching them', async () => {
    const existing = {
      id: 'r-9',
      message: rawMsg({ id: 'dm', threadId: '2b', payload: {
        mimeType: 'multipart/mixed',
        headers: hdr({ To: 'old@x.com', Cc: 'cc@x.com', Subject: 'Old', 'In-Reply-To': '<m1@x>', References: '<m0@x> <m1@x>' }),
        parts: [
          { mimeType: 'text/plain', body: { data: b64('old body') } },
          { mimeType: 'text/html', body: { data: b64('<i>old</i>') } },
          { mimeType: 'text/plain', filename: 'n.txt', body: { attachmentId: 'att9', size: 3 } },
        ],
      } }),
    };
    const { adapter, calls } = setup((c) => {
      if (c.url.pathname.includes('/attachments/')) return json({ data: b64('ABC') });
      if (c.method === 'GET') return json(existing);
      return json({ id: 'r-9', message: { id: 'dm2', threadId: '2b' } });
    });
    await adapter.updateDraft({ draftId: 'r-9', subject: 'New', body: 'new body' });
    expect(calls[0]!.url.pathname).toBe('/gmail/v1/users/me/drafts/r-9');
    expect(q(calls[0]!.url)).toEqual({ format: 'full' });
    expect(calls[1]!.url.pathname).toBe('/gmail/v1/users/me/messages/dm/attachments/att9');
    const put = calls[2]!;
    expect(put.method).toBe('PUT');
    expect(put.url.pathname).toBe('/gmail/v1/users/me/drafts/r-9');
    expect(put.body.id).toBe('r-9');
    expect(put.body.message.threadId).toBe('2b');
    const mime = decodeRaw(put);
    expect(mime).toContain('To: old@x.com\r\nCc: cc@x.com\r\nSubject: New\r\n');
    expect(mime).toContain('In-Reply-To: <m1@x>');
    expect(bodyOf(mime, 'text/plain')).toBe('new body');
    expect(bodyOf(mime, 'text/html')).toBe('<i>old</i>');
    expect(mime).toContain('filename="n.txt"');
    expect(mime).toContain(Buffer.from('ABC').toString('base64'));

    // replacing attachments does not fetch the old ones
    await adapter.updateDraft({ draftId: 'r-9', attachments: [] });
    expect(calls.slice(3).some((c) => c.url.pathname.includes('/attachments/'))).toBe(false);
    expect(decodeRaw(calls[4]!)).not.toContain('n.txt');
  });
});

describe('labels', () => {
  it('createLabel creates missing parents first, with the preset colour', async () => {
    const { adapter, calls } = setup((c) => {
      if (c.method === 'GET') return json({ labels: [{ id: 'L1', name: 'A' }] });
      return json({ id: 'L9', name: c.body.name, type: 'user' });
    });
    const l = await adapter.createLabel({ displayName: 'A/B/C', colorPreset: 'DARK_BLUE', labelListVisibility: 'LABEL_SHOW' });
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['GET', undefined],
      ['POST', { name: 'A/B' }],
      ['POST', { name: 'A/B/C', labelListVisibility: 'LABEL_SHOW', color: { backgroundColor: '#1c4587', textColor: '#ffffff' } }],
    ]);
    expect(l).toMatchObject({ labelId: 'L9', name: 'A/B/C', labelType: 'USER' });
    const s = setup();
    await s.adapter.createLabel({ displayName: 'X/Y', autoCreateParentLabels: false });
    expect(s.calls).toHaveLength(1);
  });

  it('updateLabel patches only provided fields', async () => {
    const { adapter, calls } = setup();
    await adapter.updateLabel({ labelId: 'Label_1', displayName: 'New', colorPreset: 'RED' });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ name: 'New', color: { backgroundColor: '#fb4c2f', textColor: '#ffffff' } });
  });

  it('modify posts add/remove then re-reads', async () => {
    const { adapter, calls } = setup((c) => (c.url.pathname.includes('/threads/') && c.method === 'GET' ? json({ id: 'tt', messages: [rawMsg()] }) : c.method === 'GET' ? json(rawMsg()) : json({})));
    const m = await adapter.modifyMessage({ messageId: '1a', add: ['STARRED'], remove: ['UNREAD'] });
    expect(calls[0]!.url.pathname).toBe('/gmail/v1/users/me/messages/1a/modify');
    expect(calls[0]!.body).toEqual({ addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] });
    expect(m.id).toBe('1a');
    const t = await adapter.modifyThread({ threadId: 'tt', add: ['Label_1'] });
    expect(calls[2]!.url.pathname).toBe('/gmail/v1/users/me/threads/tt/modify');
    expect(calls[2]!.body).toEqual({ addLabelIds: ['Label_1'] });
    expect(t.id).toBe('tt');
  });
});

describe('gmail policy', () => {
  const raw = b64('To: a@x.com\r\n\r\nhi');
  const denied: [string, { method: 'GET' | 'POST' | 'PUT' | 'PATCH'; url: string; body?: unknown }][] = [
    ['drafts/send', { method: 'POST', url: `${API}/drafts/send`, body: { id: 'r-1' } }],
    ['messages/send', { method: 'POST', url: `${API}/messages/send`, body: { raw } }],
    ['PUT drafts/send', { method: 'PUT', url: `${API}/drafts/send`, body: { message: { raw } } }],
    ['GET drafts/send', { method: 'GET', url: `${API}/drafts/send` }],
    ['drafts:send', { method: 'POST', url: `${API}/drafts/r-1:send`, body: {} }],
    ['trash add (message)', { method: 'POST', url: `${API}/messages/1a/modify`, body: { addLabelIds: ['TRASH'] } }],
    ['trash add lowercase (thread)', { method: 'POST', url: `${API}/threads/1a/modify`, body: { addLabelIds: [' trash'] } }],
    ['trash remove', { method: 'POST', url: `${API}/messages/1a/modify`, body: { removeLabelIds: ['Trash'] } }],
    ['trash in label create path', { method: 'POST', url: `${API}/messages/1a/trash`, body: {} }],
    ['draft extra key', { method: 'POST', url: `${API}/drafts`, body: { message: { raw }, send: true } }],
    ['draft message extra key', { method: 'POST', url: `${API}/drafts`, body: { message: { raw, labelIds: ['INBOX'] } } }],
    ['draft without raw', { method: 'POST', url: `${API}/drafts`, body: { message: {} } }],
    ['draft create with id', { method: 'POST', url: `${API}/drafts`, body: { id: 'r-1', message: { raw } } }],
    ['draft put extra key', { method: 'PUT', url: `${API}/drafts/r-1`, body: { message: { raw }, send: true } }],
    ['settings/filters POST', { method: 'POST', url: `${API}/settings/filters`, body: { action: { forward: 'x@y.z' } } }],
    ['settings/filters GET', { method: 'GET', url: `${API}/settings/filters` }],
    ['messages insert', { method: 'POST', url: `${API}/messages`, body: { raw } }],
    ['label unknown key', { method: 'POST', url: `${API}/labels`, body: { name: 'x', type: 'system' } }],
    ['label colour unknown key', { method: 'PATCH', url: `${API}/labels/L1`, body: { color: { backgroundColor: '#000000', evil: 1 } } }],
    ['modify unknown key', { method: 'POST', url: `${API}/messages/1a/modify`, body: { addLabelIds: ['X'], send: true } }],
    ['modify on a non-me user', { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/other%40x.com/messages/1a/modify', body: {} }],
    ['unlisted query key', { method: 'GET', url: `${API}/labels` }],
    ['DELETE draft', { method: 'DELETE' as never, url: `${API}/drafts/r-1` }],
    ['DELETE label', { method: 'DELETE' as never, url: `${API}/labels/L1` }],
    ['DELETE message', { method: 'DELETE' as never, url: `${API}/messages/1a` }],
  ];

  it.each(denied.filter(([n]) => n !== 'unlisted query key'))('denies %s', async (_n, req) => {
    const { http, calls } = setup();
    await expect(http.json(req)).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('denies an unlisted query key and drafts.get with a non-listed one', async () => {
    const { http, calls } = setup();
    await expect(http.json({ method: 'GET', url: `${API}/labels`, query: { x: '1' } })).rejects.toBeInstanceOf(GuardrailError);
    await expect(http.json({ method: 'GET', url: `${API}/drafts/r-1`, query: { send: 'true' } })).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('allows a clean draft save and label modify', async () => {
    const { http, calls } = setup();
    await http.json({ method: 'POST', url: `${API}/drafts`, body: { message: { raw, threadId: 'ab' } } });
    await http.json({ method: 'PUT', url: `${API}/drafts/r-1`, body: { id: 'r-1', message: { raw } } });
    await http.json({ method: 'POST', url: `${API}/messages/1a/modify`, body: { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] } });
    expect(calls).toHaveLength(3);
  });
});
