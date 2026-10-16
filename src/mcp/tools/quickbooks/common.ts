import { z } from 'zod';
import type { Account, AccountError, Tagged } from '@/core/contracts/account';
import type { QuickBooksAdapter } from '@/core/contracts/quickbooks';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { GuardrailError } from '@/core/errors';
import { failureDetail } from '@/intuit/errors';
import type { AnyToolDef } from '@/mcp/registry';

/** Every QuickBooks tool belongs to the 'intuit' provider: the registry then shows it only QuickBooks companies. */
export const qbTool = <I extends z.ZodObject<z.ZodRawShape>>(d: ToolDef<I>) => ({ ...d, provider: 'intuit' }) as unknown as AnyToolDef;

export const companyField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('QuickBooks company label (or a list). Omit to use every connected company on reads; writes need exactly one.');

export const FAN_OUT_NOTE =
  ' With several companies connected and no `account`, one result is returned per company, each tagged with its account; figures are never added across companies.';

/** Runs one QuickBooks call for one company. A failure writes one audit_log row (code only, no names or amounts) and rethrows. */
export async function qbCall<T>(ctx: ToolContext, tool: string, account: Account, targetId: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await ctx.store.audit
      .write({ tool, account: account.label, ...(targetId ? { targetId } : {}), outcome: e instanceof GuardrailError ? 'rejected' : 'error', detail: failureDetail(e) })
      .catch(() => undefined);
    throw e;
  }
}

/** A write: exactly one company, audited on success (target id only) and on failure. */
export async function qbWrite<T>(ctx: ToolContext, tool: string, account: Account, idOf: (out: T) => string | undefined, fn: () => Promise<T>): Promise<T> {
  const out = await qbCall(ctx, tool, account, undefined, fn);
  await ctx.store.audit.write({ tool, account: account.label, targetId: idOf(out), outcome: 'ok' });
  return out;
}

/** The company a write goes to: the one named, or the only one connected. Several connected and none named asks which. */
export function writeCompany(ctx: ToolContext, selector: string | string[] | undefined): Promise<Account> {
  return ctx.fanout.resolveWriteAccount(selector, async () => {
    const all = await ctx.store.accounts.list();
    return all.length === 1 ? all[0]! : null;
  });
}

export interface PerCompany<T> {
  items: Tagged<T>[];
  accountErrors: AccountError[];
}

/** Fan-out read: one result per company (never merged), each tagged. Failures are audited per company. */
export async function perCompany<T extends object>(
  ctx: ToolContext,
  tool: string,
  selector: string | string[] | undefined,
  run: (qb: QuickBooksAdapter, account: Account) => Promise<T>,
): Promise<PerCompany<T>> {
  const r = await ctx.fanout.read<T>({
    selector,
    page: { pageSize: 1000 },
    dateOf: () => 0, // one item per company; ties keep priority order
    fetch: async (account) => ({
      items: [await qbCall(ctx, tool, account, undefined, () => run(ctx.adapters.quickbooks(ctx.quickbooksContext(account)), account))],
    }),
  });
  return { items: r.items, accountErrors: r.accountErrors };
}

/** Plain-text tools: the text goes out as the tool's text block (handlers return `mcpText`), account errors appended. */
export function textResult(blocks: { account: string; text: string }[], accountErrors: AccountError[], opts: { label?: boolean } = {}) {
  const label = opts.label ?? blocks.length > 1;
  const body = blocks.map((b) => (label ? `${b.account}:\n${b.text}` : b.text));
  const notes = accountErrors.map((e) => `Not included: ${e.message}`);
  const text = body.length ? [...body, ...notes].join('\n\n') : ['STATUS: error', ...notes].join('\n\n');
  return { mcpText: text, accountErrors };
}

export const companyName = (a: Account) => a.companyName ?? a.label;

/** Input checks that run before any company is called. A refusal is audited as 'rejected' (company label if one was named). */
export async function checked<T>(ctx: ToolContext, tool: string, selector: string | string[] | undefined, fn: () => T): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof GuardrailError) {
      await ctx.store.audit
        .write({ tool, account: typeof selector === 'string' ? selector : 'unresolved', outcome: 'rejected', detail: failureDetail(e) })
        .catch(() => undefined);
    }
    throw e;
  }
}
