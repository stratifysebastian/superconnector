import { z } from 'zod';
import type { CalendarAdapter, GEvent } from '@/core/contracts/calendar';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { accountField, DAY_MS, pageSizeField, startMs, withConferenceUrl } from './common';

const eventKey = (e: GEvent) => (e.iCalUID ? `${e.iCalUID}|${e.start?.dateTime ?? e.start?.date ?? ''}` : undefined);
const eventId = (calendarId: string) => (e: GEvent) => ({ id: e.id, calendarId });

export const listCalendarsInput = z.object({
  pageSize: pageSizeField,
  pageToken: z.string().optional().describe('Opaque nextCursor from a previous call.'),
  account: accountField,
});

export const listCalendarsTool: ToolDef<typeof listCalendarsInput> = {
  name: 'list_calendars',
  description:
    'Lists calendars on every connected Google account (or the one named in `account`). Each calendar is tagged with its account.',
  input: listCalendarsInput,
  kind: 'read',
  async handler(input, ctx) {
    const r = await ctx.fanout.read({
      selector: input.account,
      page: { pageSize: input.pageSize ?? 50, cursor: input.pageToken },
      fetch: (account, pageToken, pageSize) =>
        ctx.adapters.calendar(ctx.adapterContext(account)).listCalendars({ pageSize, pageToken }),
      dateOf: () => 0,
    });
    return {
      calendars: r.items.map((c) => ({
        id: c.id,
        summary: c.summary,
        ...(c.description ? { description: c.description } : {}),
        timeZone: c.timeZone,
        ...(c.primary ? { primary: true } : {}),
        account: c.account,
        accountEmail: c.accountEmail,
      })),
      ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}),
      accountErrors: r.accountErrors,
    };
  },
};

async function eventsRead(
  ctx: ToolContext,
  input: { account?: string | string[]; pageSize?: number; pageToken?: string },
  calendarId: string,
  list: (p: { pageSize: number; pageToken?: string }) => Parameters<CalendarAdapter['listEvents']>[0],
) {
  const r = await ctx.fanout.read<GEvent>({
    selector: input.account,
    page: { pageSize: input.pageSize ?? 25, cursor: input.pageToken },
    fetch: (account, pageToken, pageSize) =>
      ctx.adapters.calendar(ctx.adapterContext(account)).listEvents(list({ pageSize, pageToken })),
    dateOf: startMs,
    dedupeKey: eventKey,
    idOf: eventId(calendarId),
  });
  return {
    events: r.items.map(withConferenceUrl),
    ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}),
    accountErrors: r.accountErrors,
  };
}

export const listEventsInput = z.object({
  calendarId: z.string().optional().describe('Defaults to "primary".'),
  startTime: z.string().optional().describe('RFC3339. Defaults to now.'),
  endTime: z.string().optional().describe('RFC3339. Defaults to start + 7 days.'),
  fullText: z.string().optional(),
  orderBy: z.enum(['startTime', 'updated']).optional(),
  pageSize: pageSizeField,
  pageToken: z.string().optional().describe('Opaque nextCursor from a previous call.'),
  eventType: z.array(z.string()).optional(),
  timeZone: z.string().optional(),
  account: accountField,
});

export const listEventsTool: ToolDef<typeof listEventsInput> = {
  name: 'list_events',
  description:
    'Lists events in a time range across every connected account (or the one named in `account`), merged newest first. A meeting on several accounts appears once with `accounts` and `sources`.',
  input: listEventsInput,
  kind: 'read',
  handler(input, ctx) {
    const calendarId = input.calendarId ?? 'primary';
    const timeMin = input.startTime ?? new Date().toISOString();
    const timeMax = input.endTime ?? new Date(Date.parse(timeMin) + 7 * DAY_MS).toISOString();
    return eventsRead(ctx, input, calendarId, (p) => ({
      ...p,
      calendarId,
      timeMin,
      timeMax,
      ...(input.fullText ? { q: input.fullText } : {}),
      ...(input.orderBy ? { orderBy: input.orderBy } : {}),
      ...(input.eventType ? { eventTypes: input.eventType } : {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    }));
  },
};

export const searchEventsInput = z.object({
  query: z.string(),
  pageSize: pageSizeField,
  pageToken: z.string().optional().describe('Opaque nextCursor from a previous call.'),
  account: accountField,
});

export const searchEventsTool: ToolDef<typeof searchEventsInput> = {
  name: 'search_events',
  description:
    'Keyword search of events on each account\'s primary calendar, from 30 days ago onwards (keyword match, not semantic search).',
  input: searchEventsInput,
  kind: 'read',
  handler(input, ctx) {
    const timeMin = new Date(Date.now() - 30 * DAY_MS).toISOString();
    return eventsRead(ctx, input, 'primary', (p) => ({
      ...p,
      calendarId: 'primary',
      q: input.query,
      timeMin,
      orderBy: 'startTime' as const,
    }));
  },
};

export const getEventInput = z.object({
  calendarId: z.string().optional().describe('Defaults to "primary".'),
  eventId: z.string(),
  account: accountField,
});

export const getEventTool: ToolDef<typeof getEventInput> = {
  name: 'get_event',
  description: 'Gets one event by id, trying accounts in priority order unless `account` is given.',
  input: getEventInput,
  kind: 'lookup',
  async handler(input, ctx) {
    const calendarId = input.calendarId ?? 'primary';
    const { item, accountErrors } = await ctx.fanout.lookup(input.account, (a) =>
      ctx.adapters.calendar(ctx.adapterContext(a)).getEvent({ calendarId, eventId: input.eventId }),
    );
    if (!item) return { message: `No event with that id was found on ${input.account ? 'the selected' : 'any connected'} account.`, accountErrors };
    return { ...withConferenceUrl(item), ...(accountErrors.length ? { accountErrors } : {}) };
  },
};
