import { z } from 'zod';
import type { GDraft, GLabel, GMessage, GThread } from '@/core/contracts/gmail';
import { accountField, gmailTool, messageFormat, pageToken, toFormat } from './common';

const newest = (t: GThread) => t.messages.reduce((m, x) => Math.max(m, Number(x.internalDate) || 0), 0);

const searchInput = z.object({
  query: z.string().optional().describe('Gmail search syntax, e.g. from:amy newer_than:7d is:unread.'),
  pageSize: z.number().int().min(1).max(50).optional().describe('Default 20, max 50.'),
  pageToken,
  includeTrash: z.boolean().optional().describe('Include threads in the bin. Defaults to false.'),
  view: z.enum(['THREAD_VIEW_UNSPECIFIED', 'THREAD_VIEW_METADATA_ONLY', 'THREAD_VIEW_MINIMAL']).optional().describe('Defaults to MINIMAL (subject and snippet). METADATA_ONLY omits them.'),
  account: accountField,
});

export const searchThreadsTool = gmailTool({
  name: 'search_threads',
  description:
    'IMPORTANT: results are previews showing only the ~5 OLDEST messages of each thread; newer messages are NOT included and no truncation marker is shown. Call get_thread to read a thread in full before answering about recent, latest or unread mail. ' +
    'Searches threads on every connected account (or the one named in `account`), merged newest first by each thread\'s latest message. Not de-duplicated: the same email in two inboxes appears twice, each tagged with its account.',
  input: searchInput,
  kind: 'read',
  async handler(input, ctx) {
    const est = new Map<string, number>();
    const r = await ctx.fanout.read<GThread>({
      selector: input.account,
      page: { pageSize: input.pageSize ?? 20, cursor: input.pageToken },
      fetch: async (account, token, pageSize) => {
        const p = await ctx.adapters.gmail(ctx.adapterContext(account)).searchThreads({
          ...(input.query ? { q: input.query } : {}),
          pageSize,
          ...(token ? { pageToken: token } : {}),
          ...(input.includeTrash ? { includeTrash: true } : {}),
          view: input.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL',
        });
        est.set(account.label, p.resultSizeEstimate ?? 0);
        return { items: p.items, nextPageToken: p.nextPageToken };
      },
      dateOf: newest,
    });
    return {
      threads: r.items,
      ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}),
      resultCountEstimate: String([...est.values()].reduce((a, b) => a + b, 0)),
      accountErrors: r.accountErrors,
    };
  },
});

async function lookupOne<T extends object>(
  ctx: Parameters<typeof searchThreadsTool.handler>[1],
  account: string | string[] | undefined,
  what: string,
  find: (a: import('@/core/contracts/account').Account) => Promise<T | null>,
) {
  const { item, accountErrors } = await ctx.fanout.lookup(account, find);
  if (!item) return { message: `No ${what} with that id was found on ${account ? 'the selected' : 'any connected'} account.`, accountErrors };
  return { ...item, ...(accountErrors.length ? { accountErrors } : {}) };
}

const threadInput = z.object({ threadId: z.string(), messageFormat, account: accountField });
export const getThreadTool = gmailTool({
  name: 'get_thread',
  description: 'Gets a thread with its messages, trying accounts in priority order unless `account` is given. Drafts in the thread are omitted.',
  input: threadInput,
  kind: 'lookup',
  async handler(input, ctx) {
    const format = toFormat(input.messageFormat);
    return lookupOne<GThread>(ctx, input.account, 'thread', (a) => ctx.adapters.gmail(ctx.adapterContext(a)).getThread({ threadId: input.threadId, format }));
  },
});

const messageInput = z.object({ messageId: z.string(), messageFormat, account: accountField });
export const getMessageTool = gmailTool({
  name: 'get_message',
  description: 'Gets one message by id, trying accounts in priority order unless `account` is given. Not for drafts (use get_draft).',
  input: messageInput,
  kind: 'lookup',
  async handler(input, ctx) {
    const format = toFormat(input.messageFormat);
    return lookupOne<GMessage>(ctx, input.account, 'message', (a) => ctx.adapters.gmail(ctx.adapterContext(a)).getMessage({ messageId: input.messageId, format }));
  },
});

const draftInput = z.object({ draftId: z.string(), messageFormat, account: accountField });
export const getDraftTool = gmailTool({
  name: 'get_draft',
  description: 'Gets one draft by id, trying accounts in priority order unless `account` is given.',
  input: draftInput,
  kind: 'lookup',
  async handler(input, ctx) {
    const format = toFormat(input.messageFormat);
    return lookupOne<GDraft>(ctx, input.account, 'draft', (a) => ctx.adapters.gmail(ctx.adapterContext(a)).getDraft({ draftId: input.draftId, format }));
  },
});

const listDraftsInput = z.object({
  pageSize: z.number().int().min(1).max(50).optional().describe('Default 20, max 50.'),
  pageToken,
  query: z.string().optional().describe('Gmail search syntax.'),
  view: z.enum(['DRAFT_VIEW_UNSPECIFIED', 'DRAFT_VIEW_METADATA_ONLY', 'DRAFT_VIEW_FULL']).optional().describe('Defaults to metadata only. DRAFT_VIEW_FULL adds subject and plaintextBody.'),
  account: accountField,
});
export const listDraftsTool = gmailTool({
  name: 'list_drafts',
  description: 'Lists drafts on every connected account (or the one named in `account`), merged newest first. Each draft is tagged with its account.',
  input: listDraftsInput,
  kind: 'read',
  async handler(input, ctx) {
    const r = await ctx.fanout.read<GDraft>({
      selector: input.account,
      page: { pageSize: input.pageSize ?? 20, cursor: input.pageToken },
      fetch: (account, token, pageSize) =>
        ctx.adapters.gmail(ctx.adapterContext(account)).listDrafts({
          ...(input.query ? { q: input.query } : {}),
          pageSize,
          ...(token ? { pageToken: token } : {}),
          full: input.view === 'DRAFT_VIEW_FULL',
        }),
      dateOf: (d) => Date.parse(d.date ?? '') || 0,
    });
    return { drafts: r.items, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}), accountErrors: r.accountErrors };
  },
});

const listLabelsInput = z.object({ account: accountField });
export const listLabelsTool = gmailTool({
  name: 'list_labels',
  description: 'Lists labels on every connected account (or the one named in `account`). Label ids are per account; each label is tagged with its account.',
  input: listLabelsInput,
  kind: 'read',
  async handler(input, ctx) {
    const r = await ctx.fanout.read<GLabel>({
      selector: input.account,
      page: { pageSize: 1000 },
      fetch: async (account) => ({ items: await ctx.adapters.gmail(ctx.adapterContext(account)).listLabels() }),
      dateOf: () => 0,
    });
    return { labels: r.items, accountErrors: r.accountErrors };
  },
});
