import { describe, expect, it } from 'vitest';
import { GuardrailError, ProviderError } from '@/core/errors';
import { ENDPOINT_RULES } from '@/google/endpoints';
import { SELF_SEND_URL, buildSelfMime } from '@/google/endpoints/gmail-self-send';
import { checkRequest, type Transport } from '@/google/endpoints/policy';
import { createGoogleHttp } from '@/google/http';

const SELF = 'seb@stratify.example';
const SEND = SELF_SEND_URL;
const SEND_Q = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send'; // drafts variant
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const msg = (headers: string[], body = 'hi') => `${headers.join('\r\n')}\r\n\r\n${body}`;
const GOOD = [`From: ${SELF}`, `To: ${SELF}`, 'Subject: hi', 'MIME-Version: 1.0', 'Content-Type: text/plain'];

const policy = (over: { url?: string; body?: unknown; query?: Record<string, string>; transport?: Transport; selfEmail?: string | undefined; method?: string }) =>
  checkRequest(ENDPOINT_RULES, {
    method: over.method ?? 'POST',
    url: over.url ?? SEND,
    query: over.query ?? {},
    body: 'body' in over ? over.body : { raw: b64(msg(GOOD)) },
    transport: over.transport ?? 'self-send',
    selfEmail: 'selfEmail' in over ? over.selfEmail : SELF,
  });

describe('policy: the self-send rule', () => {
  it('allows a message From and To the account only', () => {
    expect(policy({})).toEqual({ ok: true });
    expect(policy({ body: { raw: b64(msg(GOOD.map((h) => h.replace(SELF, SELF.toUpperCase())))) } })).toEqual({ ok: true }); // case-insensitive
  });

  const denied = (name: string, over: Parameters<typeof policy>[0]) =>
    it(`denies ${name}`, () => expect(policy(over).ok).toBe(false));
  const withHeaders = (hs: string[]) => ({ body: { raw: b64(msg(hs)) } });

  denied('a different To', withHeaders([`From: ${SELF}`, 'To: victim@evil.test', 'Subject: x']));
  denied('an added Bcc', withHeaders([...GOOD, 'Bcc: victim@evil.test']));
  denied('an added Cc', withHeaders([...GOOD, 'Cc: victim@evil.test']));
  denied('Reply-To, Sender, Resent-To, receipts', withHeaders([...GOOD, 'Reply-To: x@evil.test']));
  denied('Sender', withHeaders([...GOOD, 'Sender: x@evil.test']));
  denied('Resent-To', withHeaders([...GOOD, 'Resent-To: x@evil.test']));
  denied('Disposition-Notification-To', withHeaders([...GOOD, 'Disposition-Notification-To: x@evil.test']));
  denied('Return-Receipt-To', withHeaders([...GOOD, 'Return-Receipt-To: x@evil.test']));
  denied('two To headers', withHeaders([...GOOD, 'To: victim@evil.test']));
  denied('two To headers, the account twice', withHeaders([...GOOD, `To: ${SELF}`]));
  denied('two From headers', withHeaders([...GOOD, 'From: victim@evil.test']));
  denied('a To that lists the account and another', withHeaders([`From: ${SELF}`, `To: ${SELF}, victim@evil.test`]));
  denied('a To with a display name', withHeaders([`From: ${SELF}`, `To: Seb <${SELF}>`]));
  denied('a folded Bcc hidden in a continuation line', withHeaders([`From: ${SELF}`, `To: ${SELF}`, 'Subject: x', ' Bcc: victim@evil.test']));
  denied('a folded To that smuggles a second address', withHeaders([`From: ${SELF}`, `To: ${SELF},`, ' victim@evil.test']));
  denied('a folded header name', withHeaders([`From: ${SELF}`, `To: ${SELF}`, 'B', ' cc: victim@evil.test']));
  denied('an encoded-word To', withHeaders([`From: ${SELF}`, `To: =?UTF-8?B?${Buffer.from('victim@evil.test').toString('base64')}?=`]));
  denied('a From that differs', withHeaders([`From: other@stratify.example`, `To: ${SELF}`]));
  denied('a missing From', withHeaders([`To: ${SELF}`]));
  denied('a bare-CR line break before a Bcc', { body: { raw: b64(`From: ${SELF}\rTo: ${SELF}\rBcc: x@evil.test\r\rhi`) } });
  denied('a message with no header/body separator', { body: { raw: b64(`From: ${SELF}\r\nTo: ${SELF}`) } });
  denied('threadId in the body', { body: { raw: b64(msg(GOOD)), threadId: 't1' } });
  denied('another body key', { body: { raw: b64(msg(GOOD)), to: 'x@evil.test' } });
  denied('a missing raw', { body: {} });
  denied('a non-base64url raw', { body: { raw: 'not base64!!' } });
  denied('a query param', { query: { sendUpdates: 'none' } });
  denied('any query key', { query: { fields: 'id' } });
  denied('a different path (drafts send)', { url: SEND_Q });
  denied('the json transport on the send path', { transport: 'json' });
  denied('the upload transport on the send path', { transport: 'upload' });
  denied('GET on the send path', { method: 'GET', body: undefined });
  denied('a missing selfEmail', { selfEmail: undefined });
  denied('a selfEmail that is not a plain address', { selfEmail: `Seb <${SELF}>` });
  denied('another account address as selfEmail', { selfEmail: 'other@stratify.example' });
  denied('the self-send transport on a different Gmail path', { url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts' });
  denied('the self-send transport on a read path', { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels', body: undefined });

  it('drafts send is denied on every transport, with or without selfEmail', () => {
    for (const transport of ['json', 'upload', 'download', 'self-send'] as const) {
      expect(policy({ url: SEND_Q, transport }).ok).toBe(false);
      expect(policy({ url: SEND_Q, transport, selfEmail: undefined }).ok).toBe(false);
    }
  });

  it('the hard ban still names messages send for the json transport', () => {
    const r = policy({ transport: 'json' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('hard-ban/gmail-send');
  });

  it('a percent-encoded send path is not carved out', () => {
    expect(policy({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/%73end' }).ok).toBe(false);
  });
});

function setup(responses: Response[], ...rest: [selfEmail?: string | undefined]) {
  const selfEmail = rest.length ? rest[0] : SELF; // an explicit undefined means "missing"
  const calls: { url: string; init: RequestInit }[] = [];
  const http = createGoogleHttp({
    getAccessToken: async () => 'tok',
    selfEmail,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error('no more responses');
      return r;
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { http, calls };
}
const ok = () => new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });
const rawOf = (c: { init: RequestInit }) => Buffer.from((JSON.parse(c.init.body as string) as { raw: string }).raw, 'base64url').toString('utf8');
const headerBlock = (raw: string) => raw.split('\r\n\r\n')[0]!;

describe('GoogleHttp.sendToSelf', () => {
  it('posts one { raw } to the send path with no query, From and To both the account', async () => {
    const { http, calls } = setup([ok()]);
    await expect(http.sendToSelf({ subject: 'Brief', body: 'Hello' })).resolves.toEqual({ id: 'm1', threadId: 't1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SEND);
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, string>;
    expect(Object.keys(body)).toEqual(['raw']);
    const raw = rawOf(calls[0]!);
    const names = headerBlock(raw).split('\r\n').map((l) => l.split(':')[0]!.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(['from', 'to', 'subject', 'date', 'message-id', 'mime-version']));
    for (const banned of ['cc', 'bcc', 'reply-to', 'sender']) expect(names).not.toContain(banned);
    expect(headerBlock(raw)).toContain(`From: ${SELF}\r\nTo: ${SELF}\r\n`);
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@stratify\.example>/);
  });

  it('uses multipart/alternative with base64 parts when htmlBody is given', async () => {
    const { http, calls } = setup([ok()]);
    await http.sendToSelf({ subject: 'x', body: 'plain text', htmlBody: '<p>html</p>' });
    const raw = rawOf(calls[0]!);
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain(Buffer.from('<p>html</p>').toString('base64'));
    expect(raw).toContain(Buffer.from('plain text').toString('base64'));
    expect(raw).not.toContain('<p>');
  });

  it('RFC 2047 encodes a non-ASCII subject', async () => {
    const { http, calls } = setup([ok()]);
    await http.sendToSelf({ subject: 'Résumé du matin — 日本語', body: 'b' });
    const head = headerBlock(rawOf(calls[0]!));
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(/^[\x20-\x7e\r\n]*$/.test(head)).toBe(true);
  });

  it('a CRLF-injected subject produces no Bcc header', async () => {
    const { http, calls } = setup([ok()]);
    await http.sendToSelf({ subject: 'Hi\r\nBcc: x@evil.test', body: 'b' });
    const head = headerBlock(rawOf(calls[0]!));
    expect(head.split('\r\n').some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(head).toContain('Subject: Hi Bcc: x@evil.test');
    for (const bad of ['\u0000', '\u0085', ' ', '\v', '\f']) {
      const m = buildSelfMime(SELF, { subject: `a${bad}Bcc: x@evil.test`, body: 'b' });
      expect(m.split('\r\n\r\n')[0]!.split('\r\n').some((l) => /^bcc:/i.test(l))).toBe(false);
    }
    // and the finished message passes the policy
    expect(policy({ body: { raw: b64(buildSelfMime(SELF, { subject: 'Hi\r\nBcc: x@evil.test', body: 'b' })) } })).toEqual({ ok: true });
  });

  it('a long non-ASCII subject (folded encoded words) still passes the policy', () => {
    const raw = b64(buildSelfMime(SELF, { subject: '日本語'.repeat(60), body: 'b', htmlBody: '<b>x</b>' }));
    expect(policy({ body: { raw } })).toEqual({ ok: true });
  });

  it('blocks without selfEmail, or with one that is not a plain address, with no fetch', async () => {
    for (const bad of [undefined, '', `Seb <${SELF}>`, `${SELF}, victim@evil.test`, 'a@b']) {
      const { http, calls } = setup([ok()], bad);
      await expect(http.sendToSelf({ subject: 's', body: 'b' })).rejects.toBeInstanceOf(GuardrailError);
      expect(calls).toHaveLength(0);
    }
  });

  it('never retries a 5xx: one call, an upstream error', async () => {
    const { http, calls } = setup([new Response('{}', { status: 503 }), ok()]);
    const err = await http.sendToSelf({ subject: 's', body: 'b' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('upstream_error');
    expect(calls).toHaveLength(1);
  });

  it('the generic json() cannot reach the send path even with the account address', async () => {
    const { http, calls } = setup([ok()]);
    await expect(http.json({ method: 'POST', url: SEND, body: { raw: b64(msg(GOOD)) } })).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('does not log message content, recipients or tokens', async () => {
    const events: unknown[] = [];
    const http = createGoogleHttp({
      getAccessToken: async () => 'tok-SECRET',
      selfEmail: SELF,
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
      log: { info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e) },
    });
    await http.sendToSelf({ subject: 'SUBJECT-MARKER', body: 'BODY-MARKER' });
    const logged = JSON.stringify(events);
    for (const m of ['SUBJECT-MARKER', 'BODY-MARKER', 'tok-SECRET', SELF, 'raw']) expect(logged).not.toContain(m);
  });
});
