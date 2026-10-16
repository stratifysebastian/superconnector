import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { DraftContent, GMessage, GThread } from '@/core/contracts/gmail';
import type { ToolContext } from '@/core/contracts/tool';
import { GuardrailError } from '@/core/errors';
import { accountField, audited, gmailTool, hasTrash, isTrashWord, reject, tag, writeAccount } from './common';

const attachment = z.object({
  content: z.string().describe('Base64 content.'),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  inline: z.boolean().optional(),
});
const content = {
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional().describe('Plain text. No Markdown.'),
  htmlBody: z.string().optional(),
  attachments: z.array(attachment).optional(),
  account: accountField,
};
const toContent = (i: DraftContent): DraftContent => {
  const out: DraftContent = {};
  for (const k of ['to', 'cc', 'bcc', 'subject', 'body', 'htmlBody', 'attachments'] as const) if (i[k] !== undefined) (out as Record<string, unknown>)[k] = i[k];
  return out;
};
const idOf = (o: { id: string }) => o.id;
const gmail = (ctx: ToolContext, a: Account) => ctx.adapters.gmail(ctx.adapterContext(a));

const createInput = z.object({
  ...content,
  includeSignature: z.boolean().optional().describe('Accepted but ignored: the signature lives in Gmail settings, which this server does not read.'),
  replyToMessageId: z.string().optional().describe('Makes this a reply draft in that message\'s thread. The account defaults to the one holding that message.'),
});
export const createDraftTool = gmailTool({
  name: 'create_draft',
  description:
    'Saves a new draft (never sends it) on exactly one account: `account` is required unless `replyToMessageId` is given, which selects the account holding that message. includeSignature is ignored.',
  input: createInput,
  kind: 'write',
  async handler(input, ctx) {
    const reply = input.replyToMessageId;
    const account = await writeAccount(ctx, input.account, async (a) =>
      reply ? gmail(ctx, a).getMessage({ messageId: reply, format: 'METADATA_ONLY' }) : null,
    );
    const draft = await audited(ctx, 'create_draft', account, reply, idOf, () =>
      gmail(ctx, account).createDraft({ ...toContent(input), ...(reply ? { replyToMessageId: reply } : {}) }),
    );
    return tag(draft, account);
  },
});

const updateInput = z.object({ draftId: z.string(), ...content });
export const updateDraftTool = gmailTool({
  name: 'update_draft',
  description:
    'Updates a draft (never sends it). Provided fields replace, omitted fields keep. Attachments are NOT merged: they are removed unless re-provided. The account defaults to the one holding the draft.',
  input: updateInput,
  kind: 'write',
  async handler(input, ctx) {
    const account = await writeAccount(ctx, input.account, (a) => gmail(ctx, a).getDraft({ draftId: input.draftId, format: 'METADATA_ONLY' }));
    const draft = await audited(ctx, 'update_draft', account, input.draftId, idOf, () =>
      gmail(ctx, account).updateDraft({ ...toContent(input), draftId: input.draftId }),
    );
    return tag(draft, account);
  },
});

const labelFields = {
  labelListVisibility: z.enum(['LABEL_LIST_VISIBILITY_UNSPECIFIED', 'LABEL_SHOW', 'LABEL_SHOW_IF_UNREAD', 'LABEL_HIDE']).optional(),
  messageListVisibility: z.enum(['MESSAGE_LIST_VISIBILITY_UNSPECIFIED', 'SHOW', 'HIDE']).optional(),
  colorPreset: z.string().optional().describe('LABEL_COLOR_PRESET_* (e.g. LABEL_COLOR_PRESET_BLUE).'),
  account: accountField,
};
const labelWrite = (i: { displayName?: string; labelListVisibility?: string; messageListVisibility?: string; colorPreset?: string }) => ({
  ...(i.displayName !== undefined ? { displayName: i.displayName } : {}),
  ...(i.labelListVisibility && !i.labelListVisibility.endsWith('UNSPECIFIED') ? { labelListVisibility: i.labelListVisibility as 'LABEL_SHOW' } : {}),
  ...(i.messageListVisibility && !i.messageListVisibility.endsWith('UNSPECIFIED') ? { messageListVisibility: i.messageListVisibility as 'SHOW' } : {}),
  ...(i.colorPreset && i.colorPreset !== 'LABEL_COLOR_PRESET_UNSPECIFIED' ? { colorPreset: i.colorPreset } : {}),
});

const createLabelInput = z.object({
  displayName: z.string().describe('Nested labels use "/", e.g. Projects/Alpha.'),
  autoCreateParentLabels: z.boolean().optional().describe('Defaults to true.'),
  ...labelFields,
});
export const createLabelTool = gmailTool({
  name: 'create_label',
  description: 'Creates a label on exactly one account (`account` is required).',
  input: createLabelInput,
  kind: 'write',
  async handler(input, ctx) {
    const account = await ctx.fanout.resolveWriteAccount(input.account);
    const label = await audited(ctx, 'create_label', account, undefined, (l) => l.labelId, () =>
      gmail(ctx, account).createLabel({ ...labelWrite(input), displayName: input.displayName, ...(input.autoCreateParentLabels !== undefined ? { autoCreateParentLabels: input.autoCreateParentLabels } : {}) }),
    );
    return tag(label, account);
  },
});

const updateLabelInput = z.object({ labelId: z.string(), displayName: z.string().optional(), ...labelFields });
export const updateLabelTool = gmailTool({
  name: 'update_label',
  description: 'Renames or restyles a label on exactly one account (`account` is required, because label ids are per account).',
  input: updateLabelInput,
  kind: 'write',
  async handler(input, ctx) {
    const account = await ctx.fanout.resolveWriteAccount(input.account);
    const label = await audited(ctx, 'update_label', account, input.labelId, (l) => l.labelId, () =>
      gmail(ctx, account).updateLabel({ ...labelWrite(input), labelId: input.labelId }),
    );
    return tag(label, account);
  },
});

type Kind = 'message' | 'thread';

/** One label change on a message or thread. TRASH is refused first, before any adapter call. */
async function modify(
  ctx: ToolContext,
  tool: string,
  kind: Kind,
  id: string,
  selector: string | string[] | undefined,
  add: string[] | undefined,
  remove: string[] | undefined,
) {
  if (hasTrash(add, remove)) {
    await reject(ctx, tool, selector, id, 'no_trash', 'The bin label cannot be added or removed here, so nothing was changed.');
  }
  if (!add?.length && !remove?.length) throw new GuardrailError('bad_request', 'Provide at least one label id to add or remove.');
  const account = await writeAccount(ctx, selector, (a) =>
    kind === 'message'
      ? gmail(ctx, a).getMessage({ messageId: id, format: 'METADATA_ONLY' })
      : gmail(ctx, a).getThread({ threadId: id, format: 'METADATA_ONLY' }),
  );
  const a = gmail(ctx, account);
  const body = { ...(add?.length ? { add } : {}), ...(remove?.length ? { remove } : {}) };
  const out: GMessage | GThread = await audited<GMessage | GThread>(ctx, tool, account, id, (o) => o.id, () =>
    kind === 'message' ? a.modifyMessage({ messageId: id, ...body }) : a.modifyThread({ threadId: id, ...body }),
  );
  return tag(out, account);
}

const labelIds = z.array(z.string()).describe('Label ids (not names); see list_labels.');
const msg = { messageId: z.string(), account: accountField };
const thr = { threadId: z.string(), account: accountField };

const labelTool = (name: string, kind: Kind, mode: 'add' | 'remove', description: string) => {
  const input = z.object({ ...(kind === 'message' ? msg : thr), labelIds });
  return gmailTool({
    name,
    description: `${description} The account defaults to the one holding the ${kind}. The bin label is refused.`,
    input,
    kind: 'write',
    handler(i, ctx) {
      const id = kind === 'message' ? (i as { messageId: string }).messageId : (i as { threadId: string }).threadId;
      return modify(ctx, name, kind, id, i.account, mode === 'add' ? i.labelIds : undefined, mode === 'remove' ? i.labelIds : undefined);
    },
  });
};

const updateMessageLabelsInput = z.object({ ...msg, addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional() });

// Spam moves: SPAM is allowed; the bin never is.
const spamTool = (name: string, kind: Kind, on: boolean) => {
  const input = z.object(kind === 'message' ? msg : thr);
  return gmailTool({
    name,
    description: `${on ? 'Marks' : 'Unmarks'} a ${kind} as spam (${on ? 'adds SPAM, removes INBOX' : 'removes SPAM, adds INBOX'}). The account defaults to the one holding it.`,
    input,
    kind: 'write',
    handler(i, ctx) {
      const id = kind === 'message' ? (i as { messageId: string }).messageId : (i as { threadId: string }).threadId;
      return modify(ctx, name, kind, id, i.account, on ? ['SPAM'] : ['INBOX'], on ? ['INBOX'] : ['SPAM']);
    },
  });
};

// labelOption is a plain string so no bin literal appears in this file; TRASH and unspecified are refused below.
const sensitiveTool = (name: string, kind: Kind) => {
  const input = z.object({ ...(kind === 'message' ? msg : thr), labelOption: z.string().describe('SPAM. (The bin option is refused.)') });
  return gmailTool({
    name,
    description: `Applies a sensitive label to a ${kind}. Only SPAM is supported (adds SPAM, removes INBOX); the bin is refused. Prefer ${kind === 'message' ? 'mark_message_spam' : 'mark_thread_spam'}.`,
    input,
    kind: 'write',
    async handler(i, ctx) {
      const id = kind === 'message' ? (i as { messageId: string }).messageId : (i as { threadId: string }).threadId;
      if (isTrashWord(i.labelOption)) await reject(ctx, name, i.account, id, 'no_trash', 'Moving mail to the bin is refused, so nothing was changed.');
      if (i.labelOption.trim().toUpperCase() !== 'SPAM') {
        await ctx.store.audit.write({ tool: name, account: typeof i.account === 'string' ? i.account : 'unresolved', targetId: id, outcome: 'rejected' });
        throw new GuardrailError('bad_request', 'labelOption must be SPAM. Nothing was changed.');
      }
      return modify(ctx, name, kind, id, i.account, ['SPAM'], ['INBOX']);
    },
  });
};

export const labelAndSpamTools = () => [
  createLabelTool,
  updateLabelTool,
  labelTool('label_message', 'message', 'add', 'Adds labels to a message.'),
  labelTool('label_thread', 'thread', 'add', 'Adds labels to every message in a thread.'),
  labelTool('unlabel_message', 'message', 'remove', 'Removes labels from a message.'),
  labelTool('unlabel_thread', 'thread', 'remove', 'Removes labels from every message in a thread.'),
  gmailTool({
    name: 'update_message_labels',
    description: 'Adds and/or removes labels on a message in one step. The account defaults to the one holding the message. The bin label is refused.',
    input: updateMessageLabelsInput,
    kind: 'write',
    handler: (i, ctx) => modify(ctx, 'update_message_labels', 'message', i.messageId, i.account, i.addLabelIds, i.removeLabelIds),
  }),
  sensitiveTool('apply_sensitive_message_label', 'message'),
  sensitiveTool('apply_sensitive_thread_label', 'thread'),
  spamTool('mark_message_spam', 'message', true),
  spamTool('mark_thread_spam', 'thread', true),
  spamTool('unmark_message_spam', 'message', false),
  spamTool('unmark_thread_spam', 'thread', false),
];
