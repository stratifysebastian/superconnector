import { z } from 'zod';
import { resolveAccounts } from '@/core/accounts';
import type { AccountError } from '@/core/contracts/account';
import type { ToolDef } from '@/core/contracts/tool';
import { accountField } from './common';
import { computeFreeSlots, formatIso, formatOffset, offsetOfIso, type Interval } from './slots';

export const suggestTimeInput = z.object({
  attendeeEmails: z.array(z.string()),
  startTime: z.string().describe('RFC3339 start of the search window.'),
  endTime: z.string().describe('RFC3339 end of the search window.'),
  durationMinutes: z.number().int().min(1).optional().describe('Default 30.'),
  preferences: z
    .object({
      startHour: z.number().min(0).max(24).optional().describe('Local hour a day opens. Default 9.'),
      endHour: z.number().min(0).max(24).optional().describe('Local hour a day closes. Default 17.'),
      excludeWeekends: z.boolean().optional(),
      pageSize: z.number().int().min(1).max(50).optional().describe('Max slots. Default 5.'),
    })
    .optional(),
  timeZone: z.string().optional().describe('IANA zone for the hour preferences. Default: the startTime offset.'),
  account: accountField,
});

export const suggestTimeTool: ToolDef<typeof suggestTimeInput> = {
  name: 'suggest_time',
  description:
    'Finds free slots by combining free/busy from every selected account\'s primary calendar and the attendees\' calendars. Invites no one.',
  input: suggestTimeInput,
  kind: 'read',
  async handler(input, ctx) {
    const timeMin = new Date(Date.parse(input.startTime)).toISOString();
    const timeMax = new Date(Date.parse(input.endTime)).toISOString();
    const prefs = input.preferences ?? {};
    const zone = input.timeZone
      ? { timeZone: input.timeZone }
      : { offsetMinutes: offsetOfIso(input.startTime) ?? 0 };
    const accounts = resolveAccounts(input.account, await ctx.store.accounts.list());

    const busy: Interval[] = [];
    const accountErrors: AccountError[] = [];
    await Promise.all(
      accounts.map(async (acct) => {
        const { item, accountErrors: errs } = await ctx.fanout.lookup(acct.label, async (a) => {
          const own = a.email.toLowerCase();
          const ids = ['primary', ...input.attendeeEmails.filter((e) => e.toLowerCase() !== own)];
          const fb = await ctx.adapters.calendar(ctx.adapterContext(a)).freeBusy({
            timeMin,
            timeMax,
            ...(input.timeZone ? { timeZone: input.timeZone } : {}),
            ids,
          });
          return { fb };
        });
        accountErrors.push(...errs);
        for (const cal of Object.values(item?.fb ?? {})) {
          for (const b of cal.busy) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
        }
      }),
    );

    const duration = input.durationMinutes ?? 30;
    const label = 'timeZone' in zone ? zone.timeZone : formatOffset(zone.offsetMinutes);
    const timeSlots = computeFreeSlots({
      busy,
      windowStart: Date.parse(timeMin),
      windowEnd: Date.parse(timeMax),
      durationMinutes: duration,
      startHour: prefs.startHour ?? 9,
      endHour: prefs.endHour ?? 17,
      excludeWeekends: prefs.excludeWeekends ?? false,
      zone,
      limit: prefs.pageSize ?? 5,
    }).map((s) => {
      const start = formatIso(s.start, zone);
      const end = formatIso(s.end, zone);
      return {
        start: { dateTime: start, timeZone: label },
        end: { dateTime: end, timeZone: label },
        startTime: start,
        endTime: end,
        durationMinutes: Math.round((s.end - s.start) / 60000),
      };
    });
    return { timeSlots, accountErrors };
  },
};
