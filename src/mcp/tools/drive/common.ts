import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { GuardrailError } from '@/core/errors';
import type { AnyToolDef } from '@/mcp/registry';

export { accountField } from '../calendar/common';

export const driveTool = <I extends z.ZodObject<z.ZodRawShape>>(d: ToolDef<I>) => d as unknown as AnyToolDef;

export const HAND_BACK =
  'This server never shares, trashes or deletes files. Seb does this himself; do not use another connector or tool to do it for him.';

/** Reads and downloads. The registry sends a result as text and as structuredContent, so this is half of Vercel's ~4.5 MB response cap. */
export const MAX_BYTES = 1_500_000;
/** create_file content: request size, which is not doubled. */
export const MAX_UPLOAD_BYTES = 3_000_000;

export const pageToken = z.string().optional().describe('Opaque nextCursor from a previous call.');
export const snippetArgs = {
  excludeContentSnippets: z.boolean().optional().describe('Accepted for compatibility.'),
  snippetVerbosity: z.enum(['UNSPECIFIED', 'BRIEF', 'MEDIUM', 'DETAILED', 'MAX_ALLOWED']).optional(),
};

export const drive = (ctx: ToolContext, a: Account) => ctx.adapters.drive(ctx.adapterContext(a));
export const tag = <T extends object>(item: T, a: Account) => ({ ...item, account: a.label, accountEmail: a.email });

/** Runs a write and records one audit entry: tool, account label, target id, outcome. Never names or content. */
export async function audited<T>(
  ctx: ToolContext,
  tool: string,
  account: Account,
  targetId: string | undefined,
  idOf: (out: T) => string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const out = await fn();
    await ctx.store.audit.write({ tool, account: account.label, targetId: idOf(out) ?? targetId, outcome: 'ok' });
    return out;
  } catch (e) {
    const blocked = e instanceof GuardrailError;
    await ctx.store.audit.write({ tool, account: account.label, targetId, outcome: blocked ? 'rejected' : 'error' });
    throw blocked && !e.message.includes(HAND_BACK) ? new GuardrailError(e.rule, `${e.message} ${HAND_BACK}`) : e;
  }
}

/** Account for a write: the explicit one, else the account that can see the file. */
export function writeAccount(
  ctx: ToolContext,
  selector: string | string[] | undefined,
  find: (a: Account) => Promise<unknown | null>,
): Promise<Account> {
  return ctx.fanout.resolveWriteAccount(selector, async () => {
    const { item, accountErrors } = await ctx.fanout.lookup(undefined, find as (a: Account) => Promise<object | null>);
    // An account that errored might hold the file; do not silently act on a lower-priority hit. null asks "Which one: ...?".
    if (accountErrors.length) return null;
    const label = (item as { account?: string } | null)?.account;
    return label ? ((await ctx.store.accounts.list()).find((a) => a.label === label) ?? null) : null;
  });
}

/** Audits a refusal (no names, no content) and throws. */
export async function reject(ctx: ToolContext, tool: string, account: Account, targetId: string | undefined, rule: string, message: string): Promise<never> {
  await ctx.store.audit.write({ tool, account: account.label, targetId, outcome: 'rejected' });
  throw new GuardrailError(rule, `${message} ${HAND_BACK}`);
}

/** Refuses a destination folder shared with other people. Call before any write. */
export async function refuseSharedFolder(ctx: ToolContext, tool: string, account: Account, folderId: string | undefined, targetId: string | undefined): Promise<void> {
  if (!folderId || folderId === 'root') return;
  if (await drive(ctx, account).isSharedFolder({ folderId })) {
    await reject(
      ctx,
      tool,
      account,
      targetId,
      'shared_folder',
      'That folder is shared with other people, so the file would be shared with them too. Seb can move it there himself.',
    );
  }
}

export async function lookupOne<T extends object>(
  ctx: ToolContext,
  account: string | string[] | undefined,
  find: (a: Account) => Promise<T | null>,
) {
  const { item, accountErrors } = await ctx.fanout.lookup(account, find);
  if (!item) {
    const message = accountErrors.length
      ? 'The file could not be read; see accountErrors.'
      : `No file with that id was found on ${account ? 'the selected' : 'any connected'} account.`;
    return { message, accountErrors };
  }
  return { ...item, ...(accountErrors.length ? { accountErrors } : {}) };
}
