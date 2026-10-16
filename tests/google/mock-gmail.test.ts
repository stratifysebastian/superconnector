import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { AdapterContext } from '@/core/contracts/adapter';
import type { GThread, GmailAdapter } from '@/core/contracts/gmail';
import { GuardrailError, ProviderError } from '@/core/errors';
import { resetMockFaults, setMockFaults } from '@/google/mock/faults';
import { createMockGmailAdapter, resetMockGmail } from '@/google/mock/gmail';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  resetMockFaults();
  resetMockGmail();
});

function adapter(label: 'stratify' | 'prime', signal: AbortSignal = new AbortController().signal): GmailAdapter {
  const account = { label, email: `seb@${label}.example` } as Account;
  return createMockGmailAdapter({ account, signal } as unknown as AdapterContext);
}

async function pages(a: GmailAdapter, pageSize: number, q?: string): Promise<GThread[][]> {
  const out: GThread[][] = [];
  let pageToken: string | undefined;
  do {
    const page = await a.searchThreads({ pageSize, view: 'MINIMAL', ...(q ? { q } : {}), ...(pageToken ? { pageToken } : {}) });
    out.push(page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

const latest = (t: GThread): number => Math.max(...t.messages.map((m) => Number(m.internalDate)));

describe('mock gmail', () => {
  it('pages newest first without repeats, hiding spam and trash', async () => {
    const ps = await pages(adapter('stratify'), 10);
    expect(ps.map((p) => p.length)).toEqual([10, 10, 6]);
    const all = ps.flat();
    expect(new Set(all.map((t) => t.id)).size).toBe(26);
    const dates = all.map(latest);
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
    expect(all.some((t) => t.messages.some((m) => m.labelIds?.includes('SPAM') || m.labelIds?.includes('TRASH')))).toBe(false);
  });

  it('in:spam and includeTrash reach hidden mail', async () => {
    const a = adapter('prime');
    expect((await pages(a, 50, 'in:spam')).flat()).toHaveLength(3);
    const t = await a.searchThreads({ pageSize: 50, view: 'MINIMAL', includeTrash: true });
    expect(t.items).toHaveLength(27);
    expect(t.resultSizeEstimate).toBe(27);
  });

  it('matches from:, subject:, label:, is:unread and keywords', async () => {
    const a = adapter('stratify');
    expect((await pages(a, 50, 'label:Projects/Alpha')).flat().length).toBeGreaterThan(1);
    expect((await pages(a, 50, 'subject:"x"')).flat()).toHaveLength(0);
    expect((await pages(a, 50, 'from:carla subject:shared')).flat().map((t) => t.messages[0]?.subject)).toEqual(['FAKE Shared launch notice']);
    expect((await pages(a, 50, 'is:unread')).flat().every((t) => t.messages.some((m) => m.labelIds?.includes('UNREAD')))).toBe(true);
    expect((await pages(a, 50, 'Alpha kickoff')).flat()[0]?.messageCount).toBe(3);
  });

  it('follows the view/format field rules', async () => {
    const a = adapter('stratify');
    const meta = await a.getMessage({ messageId: '18f2a0000007', format: 'METADATA_ONLY' });
    expect(meta).toMatchObject({ id: '18f2a0000007', sender: expect.any(String) });
    expect(meta).not.toHaveProperty('subject');
    expect(meta).not.toHaveProperty('snippet');
    const min = await a.getMessage({ messageId: '18f2a0000007', format: 'MINIMAL' });
    expect(min?.subject).toBeTruthy();
    expect(min?.snippet).toBeTruthy();
    expect(min).not.toHaveProperty('plaintextBody');
    expect(min).not.toHaveProperty('attachments');
    const plain = await a.getMessage({ messageId: '18f2a0000007', format: 'PLAIN_TEXT' });
    expect(plain?.plaintextBody).toBeTruthy();
    expect(plain?.attachmentIds).toEqual(['att-stratify-1', 'att-stratify-2']);
    expect(plain?.attachments?.[0]).toMatchObject({ filename: 'FAKE-report.pdf', mimeType: 'application/pdf' });
    expect(plain).not.toHaveProperty('htmlBody');
    const full = await a.getMessage({ messageId: '18f2a0000007', format: 'FULL_CONTENT' });
    expect(full?.htmlBody).toBeTruthy();
    expect(await a.getMessage({ messageId: 'nope', format: 'MINIMAL' })).toBeNull();
    expect(await a.getThread({ threadId: 'nope', format: 'MINIMAL' })).toBeNull();
  });

  it('builds view urls from decimal ids and the account email', async () => {
    const t = await adapter('stratify').getThread({ threadId: '18f2a0000001', format: 'METADATA_ONLY' });
    const dec = (h: string) => BigInt(`0x${h}`).toString();
    expect(t?.viewUrl).toBe(`https://mail.google.com/mail/?authuser=seb@stratify.example#all/thread-f:${dec('18f2a0000001')}`);
    expect(t?.messages[1]?.viewUrl).toBe(
      `https://mail.google.com/mail/?authuser=seb@stratify.example#all/thread-f:${dec('18f2a0000001')}|msg-f:${dec('18f2a0000002')}`,
    );
    const d = await adapter('stratify').getDraft({ draftId: 'r-1001', format: 'PLAIN_TEXT' });
    expect(d?.viewUrl).toBe(`https://mail.google.com/mail/?authuser=seb@stratify.example#all?compose=thread-f:${dec('18f2a0000001')}%2Bmsg-a:r-1001`);
  });

  it('holds the same email in both accounts with different ids', async () => {
    const s = await adapter('stratify').getMessage({ messageId: '18f2a0000004', format: 'MINIMAL' });
    const p = await adapter('prime').getMessage({ messageId: '19a7c0000004', format: 'MINIMAL' });
    expect(s?.subject).toBe('FAKE Shared launch notice');
    expect(p?.subject).toBe(s?.subject);
    expect(s?.internalDate).toBe(p?.internalDate);
    expect(s?.id).not.toBe(p?.id);
    expect(await adapter('prime').getMessage({ messageId: '18f2a0000004', format: 'MINIMAL' })).toBeNull();
  });

  it('puts a reply draft in the original thread, and never lists it as a thread message', async () => {
    const a = adapter('stratify');
    const d = await a.createDraft({ replyToMessageId: '18f2a0000003', body: 'FAKE reply' });
    expect(d.threadId).toBe('18f2a0000001');
    expect(d).toMatchObject({ toRecipients: ['ana@vendor.example'], subject: 'Re: FAKE stratify Alpha kickoff', plaintextBody: 'FAKE reply', labelIds: ['DRAFT'] });
    expect((await a.getThread({ threadId: d.threadId, format: 'MINIMAL' }))?.messageCount).toBe(3);
    const fresh = await a.createDraft({ to: ['x@y.example'], subject: 'FAKE s', body: 'b' });
    expect(fresh.threadId).not.toBe(d.threadId);
    await expect(a.createDraft({ replyToMessageId: 'nope' })).rejects.toMatchObject({ kind: 'not_found' });
    expect((await a.listDrafts({ pageSize: 50, full: true })).items).toHaveLength(5);
  });

  it('updateDraft merges: provided fields replace, omitted keep, attachments replace', async () => {
    const a = adapter('stratify');
    const before = await a.getDraft({ draftId: 'r-1002', format: 'PLAIN_TEXT' });
    const u = await a.updateDraft({ draftId: 'r-1002', subject: 'FAKE new subject' });
    expect(u.subject).toBe('FAKE new subject');
    expect(u.plaintextBody).toBe(before?.plaintextBody);
    expect(u.toRecipients).toEqual(before?.toRecipients);
    expect(u.ccRecipients).toEqual(before?.ccRecipients);
    const u2 = await a.updateDraft({ draftId: 'r-1002', body: 'FAKE b2', to: ['z@y.example'] });
    expect(u2).toMatchObject({ subject: 'FAKE new subject', plaintextBody: 'FAKE b2', toRecipients: ['z@y.example'] });
    await expect(a.updateDraft({ draftId: 'r-nope', body: 'x' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(await a.getDraft({ draftId: 'r-nope', format: 'MINIMAL' })).toBeNull();
    expect((await a.getDraft({ draftId: 'r-1002', format: 'METADATA_ONLY' }))).not.toHaveProperty('subject');
  });

  it('createLabel makes missing parents unless told not to; system labels are read-only', async () => {
    const a = adapter('stratify');
    const l = await a.createLabel({ displayName: 'Clients/Acme/2026' });
    expect(l.labelType).toBe('USER');
    const names = (await a.listLabels()).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Clients', 'Clients/Acme', 'Clients/Acme/2026']));
    await expect(a.createLabel({ displayName: 'Orphans/Child', autoCreateParentLabels: false })).rejects.toBeInstanceOf(ProviderError);
    await expect(a.createLabel({ displayName: 'Projects/Alpha' })).rejects.toBeInstanceOf(ProviderError);
    await expect(a.updateLabel({ labelId: 'INBOX', displayName: 'X' })).rejects.toBeInstanceOf(ProviderError);
    expect((await a.updateLabel({ labelId: l.labelId, displayName: 'Clients/Acme/2027' })).name).toBe('Clients/Acme/2027');
    const alpha = (await a.listLabels()).find((x) => x.name === 'Projects/Alpha');
    expect(alpha?.messagesTotal).toBeGreaterThan(0);
  });

  it('modifies labels but refuses TRASH either way', async () => {
    const a = adapter('stratify');
    const m = await a.modifyMessage({ messageId: '18f2a0000004', add: ['STARRED'], remove: ['INBOX'] });
    expect(m.labelIds).toContain('STARRED');
    expect(m.labelIds).not.toContain('INBOX');
    const t = await a.modifyThread({ threadId: '18f2a0000001', add: ['SPAM'] });
    expect(t.messages.every((x) => x.labelIds?.includes('SPAM'))).toBe(true);
    await expect(a.modifyMessage({ messageId: '18f2a0000004', add: ['TRASH'] })).rejects.toBeInstanceOf(GuardrailError);
    await expect(a.modifyThread({ threadId: '18f2a0000001', remove: ['TRASH'] })).rejects.toBeInstanceOf(GuardrailError);
    await expect(a.modifyMessage({ messageId: 'nope', add: ['STARRED'] })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([
    ['invalid_grant', 'needs_reconnect'],
    ['rate_limited', 'rate_limited'],
  ] as const)('fault %s becomes %s', async (fault, kind) => {
    setMockFaults({ prime: fault });
    await expect(adapter('prime').searchThreads({ pageSize: 5, view: 'MINIMAL' })).rejects.toMatchObject({ kind });
    await expect(adapter('stratify').searchThreads({ pageSize: 5, view: 'MINIMAL' })).resolves.toBeDefined();
  });

  it('timeout fault rejects when the signal aborts', async () => {
    setMockFaults({ prime: 'timeout' });
    const ac = new AbortController();
    const p = adapter('prime', ac.signal).listLabels();
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reset restores the fixtures and accounts stay separate', async () => {
    const a = adapter('stratify');
    await a.createDraft({ body: 'x' });
    await a.createLabel({ displayName: 'Temp' });
    await a.modifyMessage({ messageId: '18f2a0000004', add: ['STARRED'] });
    expect((await adapter('prime').listDrafts({ pageSize: 50, full: false })).items).toHaveLength(3);
    resetMockGmail();
    expect((await a.listDrafts({ pageSize: 50, full: false })).items).toHaveLength(3);
    expect((await a.listLabels()).some((l) => l.name === 'Temp')).toBe(false);
    expect((await a.getMessage({ messageId: '18f2a0000004', format: 'METADATA_ONLY' }))?.labelIds).not.toContain('STARRED');
  });
});
