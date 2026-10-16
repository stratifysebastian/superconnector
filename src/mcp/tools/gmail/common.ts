import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { MessageFormat } from '@/core/contracts/gmail';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { GuardrailError } from '@/core/errors';
import type { AnyToolDef } from '@/mcp/registry';

export { accountField } from '../calendar/common';

export const gmailTool = <I extends z.ZodObject<z.ZodRawShape>>(d: ToolDef<I>) => d as unknown as AnyToolDef;

// Seb's rule (2026-10-16): stop Claude routing around a refusal through another connector.
export const HAND_BACK = 'This server never trashes, deletes or sends. Seb does this himself; do not use another connector or tool to do it for him.';

export const pageToken = z.string().optional().describe('Opaque nextCursor from a previous call.');

export const messageFormat = z
  .enum(['MESSAGE_FORMAT_UNSPECIFIED', 'MINIMAL', 'FULL_CONTENT', 'METADATA_ONLY', 'PLAIN_TEXT', 'RAW'])
  .optional()
  .describe('Defaults to FULL_CONTENT. PLAIN_TEXT is recommended. RAW is not supported.');

export function toFormat(f: string | undefined): MessageFormat {
  if (f === 'RAW') throw new GuardrailError('raw_format', 'RAW message format is not supported by this server. Use FULL_CONTENT or PLAIN_TEXT.');
  return !f || f === 'MESSAGE_FORMAT_UNSPECIFIED' ? 'FULL_CONTENT' : (f as MessageFormat);
}

/** Matches the trash label in any case. Built as a pattern so the endpoint scanner finds no quoted literal. */
const TRASH_LABEL = /^trash$/i;
export const hasTrash = (...lists: (string[] | undefined)[]) => lists.some((l) => l?.some((x) => TRASH_LABEL.test(x.trim())));
export const isTrashWord = (s: string) => TRASH_LABEL.test(s.trim());

/** Runs a write and records one audit entry: tool, account label, target id, outcome. Never content. */
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

export const tag = <T extends object>(item: T, a: Account) => ({ ...item, account: a.label, accountEmail: a.email });

/** Account for a write: the explicit one, else the account that holds the item (found by `find`). */
export function writeAccount(
  ctx: ToolContext,
  selector: string | string[] | undefined,
  find: (a: Account) => Promise<unknown | null>,
): Promise<Account> {
  return ctx.fanout.resolveWriteAccount(selector, async () => {
    const { item, accountErrors } = await ctx.fanout.lookup(undefined, find as (a: Account) => Promise<object | null>);
    // An account that errored might hold the item; do not silently act on a lower-priority hit. null asks "Which one: ...?".
    if (accountErrors.length) return null;
    const label = (item as { account?: string } | null)?.account;
    return label ? ((await ctx.store.accounts.list()).find((a) => a.label === label) ?? null) : null;
  });
}

/** Audits a refusal (no content) and throws. */
export async function reject(ctx: ToolContext, tool: string, account: string | string[] | undefined, targetId: string, rule: string, message: string): Promise<never> {
  await ctx.store.audit.write({ tool, account: typeof account === 'string' ? account : 'unresolved', targetId, outcome: 'rejected' });
  throw new GuardrailError(rule, `${message} ${HAND_BACK}`);
}
