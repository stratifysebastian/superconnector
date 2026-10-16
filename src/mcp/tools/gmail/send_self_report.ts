import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { ToolContext } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { gmailTool } from './common';

export const TOOL = 'send_self_report';
export const DAILY_LIMIT = 6;
/** Vercel's request limit is about 4.5 MB; stay well inside it. */
export const MAX_CHARS = 1_500_000;
const ZONE = 'America/Toronto';

/** Milliseconds by which Toronto wall-clock time is ahead of UTC at instant `t`. */
function zoneOffsetMs(t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** The instant of the most recent midnight in America/Toronto (DST-aware, no dependency). */
export function startOfTorontoDay(now: Date): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now.getTime()));
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Offsets can differ between now and midnight on a DST day, so settle on the offset in force at midnight.
  const guess = midnightLocal - zoneOffsetMs(midnightLocal - zoneOffsetMs(now.getTime()));
  return new Date(guess);
}

const resetsAt = (now: Date): string => {
  // 30 hours after this midnight is always inside the next Toronto day, whatever DST does.
  const next = startOfTorontoDay(new Date(startOfTorontoDay(now).getTime() + 30 * 3600_000));
  return `${next.toISOString()} (midnight America/Toronto)`;
};

const input = z
  .object({
    account: z.string().min(1).describe('Exactly one account label. The report is emailed to that account\'s own address.'),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).describe('Plain text only. A "<" anywhere in it is refused; put HTML in htmlBody.'),
    htmlBody: z.string().optional().describe('Optional HTML alternative of the same report.'),
  })
  .strict();

export function createSendSelfReportTool(now: () => Date = () => new Date()) {
  return gmailTool({
    name: TOOL,
    description:
      `Emails a report to the account's OWN address and to nobody else. There is no recipient, cc, bcc, reply-to or from field, and the server has no way to email anyone else: the message is always From and To the address of the named account. ` +
      `\`account\` is required and must be one account label (not "all", not a list). \`body\` is plain text and is refused if it contains "<"; put HTML in \`htmlBody\`. ` +
      `Limit: ${DAILY_LIMIT} per account per calendar day (midnight America/Toronto); the response returns the running count. Total size is capped at about 1.5 MB.`,
    input,
    kind: 'write',
    async handler(raw, ctx: ToolContext) {
      const parsed = input.safeParse(raw);
      if (!parsed.success) throw new GuardrailError('invalid_input', 'send_self_report takes only account, subject, body and htmlBody. It cannot address anyone: there is no to, cc, bcc or from.');
      const { account: selector, subject, body, htmlBody } = parsed.data;

      if (selector.trim().toLowerCase() === 'all') {
        throw new GuardrailError('single_account', 'send_self_report needs exactly one account label, not "all".');
      }
      const account: Account = await ctx.fanout.resolveWriteAccount(selector);

      const reject = async (rule: string, message: string): Promise<never> => {
        await ctx.store.audit.write({ tool: TOOL, account: account.label, outcome: 'rejected', detail: rule });
        throw new GuardrailError(rule, message);
      };
      if (body.includes('<')) {
        await reject('plain_text_body', 'body is plain text and must not contain "<". Put HTML in htmlBody and keep body as plain prose.');
      }
      if (Buffer.byteLength(subject + body + (htmlBody ?? '')) > MAX_CHARS) {
        await reject('too_large', 'subject, body and htmlBody together are over 1.5 MB. Send a shorter report.');
      }

      // shortcut: the cap is keyed by account label, so an admin rename at /connect resets that day's count (admin-only, A6 F2); key on account id if that ever matters.
      // Reserve first, then count: concurrent calls each see each other's reservation, so the cap can only err low.
      const at = now();
      await ctx.store.audit.write({ tool: TOOL, account: account.label, outcome: 'ok', detail: 'reserved' });
      const count = await ctx.store.audit.countToday({ tool: TOOL, account: account.label, since: startOfTorontoDay(at) });
      if (count > DAILY_LIMIT) {
        await ctx.store.audit.write({ tool: TOOL, account: account.label, outcome: 'rejected', detail: 'daily_limit' });
        throw new GuardrailError(
          'daily_limit',
          `Daily limit reached: ${DAILY_LIMIT} self-reports per account per day, and ${Math.min(count - 1, DAILY_LIMIT)} already used today for ${account.label}. The count resets at ${resetsAt(at)}.`,
        );
      }

      try {
        const sent = await ctx.adapters.gmail(ctx.adapterContext(account)).sendSelfReport({ subject, body, ...(htmlBody !== undefined ? { htmlBody } : {}) });
        return { sent: true, to: sent.to, messageId: sent.id, sentToday: count, dailyLimit: DAILY_LIMIT, account: account.label, accountEmail: account.email };
      } catch (e) {
        const detail = e instanceof ProviderError ? e.kind : e instanceof GuardrailError ? e.rule : 'error';
        await ctx.store.audit.write({ tool: TOOL, account: account.label, outcome: 'error', detail });
        throw e;
      }
    },
  });
}

export const sendSelfReportTool = createSendSelfReportTool();
