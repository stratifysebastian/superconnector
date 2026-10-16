import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { GDraft, GMessage, GmailAdapter, GThread } from '@/core/contracts/gmail';
import type { ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { GuardrailError, ProviderError } from '@/core/errors';
import { getToolDefs, type AnyToolDef } from '@/mcp/registry';
import { gmailTools } from '@/mcp/tools/gmail';
import { assertNoExcludedTools } from '../contract/excluded';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';

const acct = (label: string, priority: number): Account => ({
  id: `id-${label}`, provider: 'google', email: `seb@${label}.test`, label, orgClientId: 'org', priority,
  connectedAt: '2026-01-01T00:00:00Z', status: 'active', grantedScopes: [],
});
const accounts = [acct('stratify', 0), acct('prime', 1)];
const BIN = ['TRA', 'SH'].join('');

const msg = (id: string, ms: number, extra: Partial<GMessage> = {}): GMessage => ({
  id, threadId: `t-${id}`, internalDate: String(ms), date: new Date(ms).toISOString(), viewUrl: 'u', ...extra,
});
const thread = (id: string, ...ms: number[]): GThread => ({
  id, messageCount: ms.length, viewUrl: 'u', messages: ms.map((m, i) => msg(`${id}-m${i}`, m)),
});

interface Fake extends GmailAdapter { threads: GThread[]; drafts: GDraft[]; messages: GMessage[]; fail?: ProviderError }
let fakes: Record<string, Fake>;
let audit: { tool: string; account: string; targetId?: string; outcome: string }[];
let ctx: ToolContext;

function makeFake(): Fake {
  const f = {
    threads: [], drafts: [], messages: [],
    searchThreads: vi.fn(async (p) => {
      if (f.fail) throw f.fail;
      const s = Number(p.pageToken ?? 0);
      return { items: f.threads.slice(s, s + p.pageSize), ...(s + p.pageSize < f.threads.length ? { nextPageToken: String(s + p.pageSize) } : {}), resultSizeEstimate: f.threads.length };
    }),
    getThread: vi.fn(async (p) => f.threads.find((t) => t.id === p.threadId) ?? null),
    getMessage: vi.fn(async (p) => f.messages.find((m) => m.id === p.messageId) ?? null),
    listDrafts: vi.fn(async () => ({ items: f.drafts })),
    getDraft: vi.fn(async (p) => f.drafts.find((d) => d.id === p.draftId) ?? null),
    createDraft: vi.fn(async () => ({ id: 'r-1', messageId: 'm', threadId: 't', viewUrl: 'u' })),
    updateDraft: vi.fn(async (p) => ({ id: p.draftId, messageId: 'm', threadId: 't', viewUrl: 'u' })),
    listLabels: vi.fn(async () => [{ labelId: 'INBOX', name: 'INBOX', labelType: 'SYSTEM' as const }]),
    createLabel: vi.fn(async (p) => ({ labelId: 'Label_1', name: p.displayName, labelType: 'USER' as const })),
    updateLabel: vi.fn(async (p) => ({ labelId: p.labelId, name: 'x', labelType: 'USER' as const })),
    modifyMessage: vi.fn(async (p) => msg(p.messageId, 1)),
    modifyThread: vi.fn(async (p) => thread(p.threadId, 1)),
  } as unknown as Fake;
  return f;
}

beforeEach(() => {
  fakes = { stratify: makeFake(), prime: makeFake() };
  audit = [];
  ctx = {
    store: { accounts: { list: async () => accounts }, audit: { write: async (e: (typeof audit)[number]) => void audit.push(e) } },
    fanout: createFanOutEngine({ listAccounts: async () => accounts, cursorSecret: 's'.repeat(32), reconnectUrl: '/connect' }),
    adapters: { gmail: (c: { account: Account }) => fakes[c.account.label]! },
    adapterContext: (account: Account) => ({ account }),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ToolContext;
});

const tool = (name: string): AnyToolDef => getToolDefs('http://x').find((d) => d.name === name)!;
const call = (name: string, args: Record<string, unknown> = {}) => {
  const def = tool(name);
  return def.handler(def.input.parse(args) as never, ctx) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const adapterCalls = () => Object.values(fakes).flatMap((f) => Object.values(f).filter(vi.isMockFunction).flatMap((m) => m.mock.calls));

describe('registry', () => {
  it('registers exactly the enabled names (21 Gmail) and no excluded tool', () => {
    const names = getToolDefs('http://x').map((d) => d.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(gmailTools()).toHaveLength(21);
    expect(names).toEqual(expect.arrayContaining(gmailTools().map((t) => t.name)));
    expect(() => assertNoExcludedTools(names)).not.toThrow();
  });
});

describe('reads', () => {
  beforeEach(() => {
    fakes.stratify!.threads = [thread('s1', 100, 500), thread('s2', 300), thread('s3', 50)];
    fakes.prime!.threads = [thread('p1', 400), thread('p2', 200, 250)];
  });

  it('merges newest first by latest message, round-trips the cursor and keeps duplicates', async () => {
    const first = await call('search_threads', { pageSize: 2 });
    expect(first.threads.map((t: GThread) => t.id)).toEqual(['s1', 'p1']);
    expect(first.threads[0]).toMatchObject({ account: 'stratify', accountEmail: 'seb@stratify.test' });
    expect(first.resultCountEstimate).toBe('5');
    const second = await call('search_threads', { pageSize: 2, pageToken: first.nextCursor });
    expect(second.threads.map((t: GThread) => t.id)).toEqual(['s2', 'p2']);
    const third = await call('search_threads', { pageSize: 2, pageToken: second.nextCursor });
    expect(third.threads.map((t: GThread) => t.id)).toEqual(['s3']);
    expect(third.nextCursor).toBeUndefined();
    fakes.prime!.threads = [thread('s1', 100, 500)]; // same email in both inboxes: two copies
    const both = await call('search_threads', { pageSize: 10 });
    expect(both.threads.filter((t: GThread) => t.id === 's1').map((t: { account: string }) => t.account)).toEqual(['stratify', 'prime']);
  });

  it('passes query and view through', async () => {
    await call('search_threads', { query: 'from:a', view: 'THREAD_VIEW_METADATA_ONLY', includeTrash: true });
    expect(fakes.stratify!.searchThreads).toHaveBeenCalledWith(expect.objectContaining({ q: 'from:a', view: 'METADATA_ONLY', includeTrash: true, pageSize: 20 }));
  });

  it('reports a disconnected account in accountErrors', async () => {
    fakes.prime!.fail = new ProviderError('needs_reconnect', 'invalid_grant');
    const r = await call('search_threads', {});
    expect(r.threads.map((t: GThread) => t.id)).toEqual(['s1', 's2', 's3']);
    expect(r.accountErrors[0]).toMatchObject({ account: 'prime', kind: 'needs_reconnect' });
  });

  it('get_thread / get_message / get_draft find the right account', async () => {
    fakes.prime!.messages = [msg('pm', 1)];
    fakes.prime!.drafts = [{ id: 'r-9', messageId: 'm', threadId: 't', viewUrl: 'u' }];
    expect(await call('get_thread', { threadId: 'p1' })).toMatchObject({ id: 'p1', account: 'prime' });
    expect(await call('get_message', { messageId: 'pm' })).toMatchObject({ id: 'pm', account: 'prime' });
    expect(await call('get_draft', { draftId: 'r-9' })).toMatchObject({ id: 'r-9', account: 'prime' });
    expect((await call('get_thread', { threadId: 'nope' })).message).toMatch(/No thread/);
    expect(fakes.stratify!.getThread).toHaveBeenCalledWith({ threadId: 'p1', format: 'FULL_CONTENT' });
  });

  it('refuses RAW plainly', async () => {
    await expect(call('get_message', { messageId: 'x', messageFormat: 'RAW' })).rejects.toThrow(/RAW/);
  });

  it('list_drafts merges newest first; list_labels tags per account', async () => {
    fakes.stratify!.drafts = [{ id: 'd1', messageId: 'm', threadId: 't', viewUrl: 'u', date: '2026-10-01T00:00:00Z' }];
    fakes.prime!.drafts = [{ id: 'd2', messageId: 'm', threadId: 't', viewUrl: 'u', date: '2026-10-02T00:00:00Z' }];
    expect((await call('list_drafts', {})).drafts.map((d: GDraft) => d.id)).toEqual(['d2', 'd1']);
    const l = await call('list_labels', {});
    expect(l.labels.map((x: { account: string }) => x.account)).toEqual(['stratify', 'prime']);
  });
});

describe('writes', () => {
  beforeEach(() => {
    fakes.prime!.messages = [msg('pm', 1)];
    fakes.prime!.threads = [thread('pt', 1)];
    fakes.prime!.drafts = [{ id: 'r-5', messageId: 'm', threadId: 't', viewUrl: 'u' }];
  });

  it('create_draft needs an account unless replying; a reply infers the account', async () => {
    await expect(call('create_draft', { subject: 's' })).rejects.toThrow();
    const r = await call('create_draft', { replyToMessageId: 'pm', body: 'secret body', includeSignature: true });
    expect(r).toMatchObject({ id: 'r-1', account: 'prime' });
    expect(fakes.prime!.createDraft).toHaveBeenCalledWith({ body: 'secret body', replyToMessageId: 'pm' });
    const n = await call('create_draft', { account: 'stratify', to: ['a@b.c'] });
    expect(n.account).toBe('stratify');
    expect(fakes.stratify!.createDraft).toHaveBeenCalledWith({ to: ['a@b.c'] });
  });

  it('update_draft defaults to the draft\'s account', async () => {
    expect(await call('update_draft', { draftId: 'r-5', subject: 'private' })).toMatchObject({ id: 'r-5', account: 'prime' });
    expect(fakes.prime!.updateDraft).toHaveBeenCalledWith({ draftId: 'r-5', subject: 'private' });
  });

  it('label tools find the holder account and call modify', async () => {
    await call('label_message', { messageId: 'pm', labelIds: ['STARRED'] });
    expect(fakes.prime!.modifyMessage).toHaveBeenCalledWith({ messageId: 'pm', add: ['STARRED'] });
    await call('unlabel_thread', { threadId: 'pt', labelIds: ['UNREAD'] });
    expect(fakes.prime!.modifyThread).toHaveBeenCalledWith({ threadId: 'pt', remove: ['UNREAD'] });
    await call('update_message_labels', { messageId: 'pm', addLabelIds: ['A'], removeLabelIds: ['B'], account: 'prime' });
    expect(fakes.prime!.modifyMessage).toHaveBeenLastCalledWith({ messageId: 'pm', add: ['A'], remove: ['B'] });
  });

  it('a policy block downstream is audited as rejected and tells Claude not to route around it', async () => {
    vi.mocked(fakes.prime!.modifyMessage).mockRejectedValueOnce(new GuardrailError('hard-ban/x', 'GoogleHttp blocked the request'));
    const err = (await call('label_message', { account: 'prime', messageId: 'pm', labelIds: ['STARRED'] }).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.message).toContain('do not use another connector');
    expect(audit.at(-1)).toMatchObject({ tool: 'label_message', outcome: 'rejected' });
  });
  it('create_label and update_label need an account', async () => {
    await expect(call('create_label', { displayName: 'X' })).rejects.toThrow();
    expect((await call('create_label', { displayName: 'X', account: 'prime' })).account).toBe('prime');
    expect((await call('update_label', { labelId: 'L', displayName: 'Y', account: 'prime' })).labelId).toBe('L');
  });

  it('spam mappings', async () => {
    await call('mark_message_spam', { messageId: 'pm' });
    expect(fakes.prime!.modifyMessage).toHaveBeenLastCalledWith({ messageId: 'pm', add: ['SPAM'], remove: ['INBOX'] });
    await call('unmark_thread_spam', { threadId: 'pt' });
    expect(fakes.prime!.modifyThread).toHaveBeenLastCalledWith({ threadId: 'pt', add: ['INBOX'], remove: ['SPAM'] });
    await call('apply_sensitive_message_label', { messageId: 'pm', labelOption: 'SPAM' });
    expect(fakes.prime!.modifyMessage).toHaveBeenLastCalledWith({ messageId: 'pm', add: ['SPAM'], remove: ['INBOX'] });
    await call('mark_thread_spam', { threadId: 'pt' });
    await call('unmark_message_spam', { messageId: 'pm' });
    await call('label_message', { messageId: 'pm', labelIds: ['SPAM'] }); // SPAM is allowed
  });

  it('refuses the bin on every label path before any adapter call', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['label_message', { messageId: 'pm', labelIds: [BIN] }],
      ['label_thread', { threadId: 'pt', labelIds: ['x', BIN.toLowerCase()] }],
      ['unlabel_message', { messageId: 'pm', labelIds: [BIN] }],
      ['unlabel_thread', { threadId: 'pt', labelIds: [BIN] }],
      ['update_message_labels', { messageId: 'pm', removeLabelIds: [BIN] }],
      ['update_message_labels', { messageId: 'pm', addLabelIds: [` ${BIN} `] }],
      ['apply_sensitive_message_label', { messageId: 'pm', labelOption: BIN }],
      ['apply_sensitive_thread_label', { threadId: 'pt', labelOption: BIN }],
    ];
    for (const [name, args] of cases) {
      await expect(call(name, args)).rejects.toThrow(GuardrailError);
      await expect(call(name, args)).rejects.toThrow(/never trashes, deletes or sends.*Seb does this himself; do not use another connector or tool to do it for him/);
    }
    expect(adapterCalls()).toHaveLength(0);
    expect(audit).toHaveLength(cases.length * 2);
    expect(audit.every((a) => a.outcome === 'rejected')).toBe(true);
  });

  it('refuses an unspecified sensitive label option', async () => {
    await expect(call('apply_sensitive_thread_label', { threadId: 'pt', labelOption: 'LABEL_OPTION_UNSPECIFIED' })).rejects.toThrow();
    expect(adapterCalls()).toHaveLength(0);
  });

  it('audit entries hold only tool, account, target and outcome', async () => {
    await call('create_draft', { account: 'prime', to: ['x@y.z'], subject: 'SUBJ', body: 'BODY' });
    await call('update_draft', { draftId: 'r-5', body: 'BODY2' });
    await call('label_message', { messageId: 'pm', labelIds: ['STARRED'] });
    fakes.prime!.modifyMessage = vi.fn(async () => { throw new ProviderError('upstream_error', 'boom'); }) as never;
    await expect(call('mark_message_spam', { messageId: 'pm' })).rejects.toThrow();
    expect(audit.map((a) => a.outcome)).toEqual(['ok', 'ok', 'ok', 'error']);
    for (const a of audit) expect(Object.keys(a).sort()).toEqual(['account', 'outcome', 'targetId', 'tool']);
    expect(JSON.stringify(audit)).not.toMatch(/SUBJ|BODY|x@y\.z/);
  });
});
