import { z } from 'zod';
import type { GEvent } from '@/core/contracts/calendar';
import type { ToolContext } from '@/core/contracts/tool';
import type { Account } from '@/core/contracts/account';

export const accountField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('Account label or email (or a list). Omit for all accounts on reads; writes need exactly one.');

export const pageSizeField = z.number().int().min(1).max(250).optional();

export const DAY_MS = 86_400_000;

/** Event start in ms: dateTime, or an all-day date at 00:00 UTC. */
export function startMs(e: GEvent): number {
  const s = e.start?.dateTime ?? e.start?.date;
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Adds the built-in `conferenceUrl` convenience field when the event has a Meet link. */
export function withConferenceUrl<T extends GEvent>(e: T): T & { conferenceUrl?: string } {
  const cd = e.conferenceData as { entryPoints?: { entryPointType?: string; uri?: string }[] } | undefined;
  const url = (e.hangoutLink as string | undefined) ?? cd?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  return url ? { ...e, conferenceUrl: url } : e;
}

/** Runs a write and records one audit entry (ok, or error before rethrowing). Never records bodies. */
export async function audited<T extends GEvent>(
  ctx: ToolContext,
  tool: string,
  account: Account,
  targetId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const out = await fn();
    await ctx.store.audit.write({ tool, account: account.label, targetId: out.id ?? targetId, outcome: 'ok' });
    return out;
  } catch (e) {
    await ctx.store.audit.write({ tool, account: account.label, targetId, outcome: 'error' });
    throw e;
  }
}
