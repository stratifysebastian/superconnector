import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { EventWriteBody, GEvent } from '@/core/contracts/calendar';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { GuardrailError, ProviderError } from '@/core/errors';
import { accountField, audited, withConferenceUrl } from './common';

const guestField = z.unknown().optional();
const attachment = z.object({ fileUrl: z.string(), title: z.string().optional(), mimeType: z.string().optional() });
const reminder = z.object({ method: z.string(), minutes: z.number() });

/** Fields shared by create and update (all optional here; create requires three of them). */
const shared = {
  calendarId: z.string().optional().describe('Defaults to "primary".'),
  summary: z.string().optional(),
  startTime: z.string().optional().describe('RFC3339, or YYYY-MM-DD when allDay.'),
  endTime: z.string().optional().describe('RFC3339, or YYYY-MM-DD when allDay.'),
  description: z.string().optional(),
  location: z.string().optional(),
  allDay: z.boolean().optional(),
  timeZone: z.string().optional(),
  recurrenceData: z.array(z.string()).optional(),
  colorId: z.string().optional(),
  visibility: z.string().optional(),
  availability: z.enum(['busy', 'free']).optional(),
  // Out-of-office and focus-time events can auto-decline other people's invitations, so they are not offered.
  eventType: z.enum(['default', 'workingLocation', 'DEFAULT', 'WORKING_LOCATION']).optional(),
  addGoogleMeetUrl: z.boolean().optional(),
  googleMeetUrl: z.string().optional().describe('Added to the description as text.'),
  overrideReminders: z.array(reminder).optional(),
  useDefaultReminders: z.boolean().optional(),
  notificationLevel: z.unknown().optional().describe('Ignored. Nobody is ever notified.'),
  workingLocationProperties: z.unknown().optional(),
  // Accepted only so they can be refused with a clear message.
  attendees: guestField,
  attendeeEmails: guestField,
  guestPermissions: guestField,
  account: accountField,
};

const NO_GUESTS = 'This server never invites anyone';
const nonEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '';

const GUEST_FIELDS = ['attendees', 'attendeeEmails', 'addedAttendees', 'addedAttendeeEmails', 'removedAttendeeEmails', 'guestPermissions'];

async function refuseGuestFields(ctx: ToolContext, tool: string, account: Account, input: Record<string, unknown>, targetId?: string) {
  if (!GUEST_FIELDS.some((k) => nonEmpty(input[k]))) return;
  await ctx.store.audit.write({ tool, account: account.label, targetId, outcome: 'rejected' });
  throw new GuardrailError(
    'no_attendees',
    tool === 'create_event'
      ? `${NO_GUESTS}. Put the people in the description instead; the event will be created with no guests.`
      : `${NO_GUESTS}, so guests and guest permissions cannot be added, removed or changed. Put the people in the description instead. Nothing was changed.`,
  );
}

type Shared = Partial<z.infer<z.ZodObject<typeof shared>>>;

/** Maps the built-in fields onto the only fields a write may send. */
function toBody(i: Shared, existingDescription?: string): EventWriteBody {
  const body: EventWriteBody = {};
  if (i.summary !== undefined) body.summary = i.summary;
  if (i.location !== undefined) body.location = i.location;
  const desc = [i.description ?? (i.googleMeetUrl ? existingDescription : undefined), i.googleMeetUrl]
    .filter((x): x is string => !!x)
    .join('\n');
  if (i.description !== undefined || i.googleMeetUrl) body.description = desc;
  const when = (t: string) =>
    i.allDay ? { date: t.slice(0, 10) } : { dateTime: t, ...(i.timeZone ? { timeZone: i.timeZone } : {}) };
  if (i.startTime) body.start = when(i.startTime);
  if (i.endTime) body.end = when(i.endTime);
  if (i.recurrenceData) body.recurrence = i.recurrenceData;
  if (i.colorId !== undefined) body.colorId = i.colorId;
  if (i.visibility !== undefined) body.visibility = i.visibility;
  if (i.availability) body.transparency = i.availability === 'free' ? 'transparent' : 'opaque';
  if (i.eventType !== undefined) body.eventType = i.eventType === 'WORKING_LOCATION' ? 'workingLocation' : i.eventType === 'DEFAULT' ? 'default' : i.eventType;
  if (i.overrideReminders || i.useDefaultReminders !== undefined) {
    body.reminders = {
      useDefault: i.useDefaultReminders ?? !i.overrideReminders,
      ...(i.overrideReminders ? { overrides: i.overrideReminders } : {}),
    };
  }
  if (i.addGoogleMeetUrl) {
    body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  if (i.workingLocationProperties !== undefined) body.workingLocationProperties = i.workingLocationProperties;
  return body;
}

const tagged = (e: GEvent, a: Account) => ({ ...withConferenceUrl(e), account: a.label, accountEmail: a.email });

export const createEventInput = z.object({
  ...shared,
  summary: z.string(),
  startTime: z.string().describe('RFC3339, or YYYY-MM-DD when allDay.'),
  endTime: z.string().describe('RFC3339, or YYYY-MM-DD when allDay.'),
  attachments: z.array(attachment).optional(),
});

export const createEventTool: ToolDef<typeof createEventInput> = {
  name: 'create_event',
  description:
    'Creates an event on exactly one account (`account` is required). Never invites anyone: attendees are refused, so list people in the description. Nobody is notified.',
  input: createEventInput,
  kind: 'write',
  async handler(input, ctx) {
    const account = await ctx.fanout.resolveWriteAccount(input.account);
    await refuseGuestFields(ctx, 'create_event', account, input);
    const body = toBody(input);
    if (input.attachments) body.attachments = input.attachments.map(({ fileUrl, title }) => ({ fileUrl, ...(title ? { title } : {}) }));
    const event = await audited(ctx, 'create_event', account, undefined, () =>
      ctx.adapters.calendar(ctx.adapterContext(account)).insertEvent({ calendarId: input.calendarId ?? 'primary', body }),
    );
    return tagged(event, account);
  },
};

export const updateEventInput = z.object({
  ...shared,
  eventId: z.string(),
  addedAttachments: z.array(attachment).optional(),
  removedAttachmentFileUrls: z.array(z.string()).optional(),
  addedAttendees: guestField,
  addedAttendeeEmails: guestField,
  removedAttendeeEmails: guestField,
});

const clock = (iso: string) => {
  const m = /T(\d\d):(\d\d)/.exec(iso);
  if (!m) return iso.slice(0, 10);
  const h = Number(m[1]);
  return { t: `${h % 12 || 12}:${m[2]}`, pm: h >= 12 };
};
function describeChange(i: z.infer<typeof updateEventInput>): string {
  const parts: string[] = [];
  if (i.startTime || i.endTime) {
    const s = i.startTime && clock(i.startTime);
    const e = i.endTime && clock(i.endTime);
    const date = (i.startTime ?? i.endTime)!.slice(0, 10);
    const range =
      s && e && typeof s === 'object' && typeof e === 'object'
        ? s.pm === e.pm
          ? `${s.t}–${e.t} ${e.pm ? 'PM' : 'AM'}`
          : `${s.t} ${s.pm ? 'PM' : 'AM'}–${e.t} ${e.pm ? 'PM' : 'AM'}`
        : '';
    parts.push(`move it to ${date}${range ? `, ${range}` : ''}`);
  }
  if (i.summary !== undefined) parts.push(`rename it to "${i.summary}"`);
  if (i.location !== undefined) parts.push(`set the location to "${i.location}"`);
  if (i.description !== undefined || i.googleMeetUrl) parts.push('change the description');
  const others = ['recurrenceData', 'colorId', 'visibility', 'availability', 'eventType', 'addGoogleMeetUrl', 'overrideReminders', 'useDefaultReminders', 'addedAttachments', 'removedAttachmentFileUrls', 'workingLocationProperties'].filter(
    (k) => (i as Record<string, unknown>)[k] !== undefined,
  );
  if (others.length) parts.push(`update ${others.join(', ')}`);
  return parts.length ? parts.join('; ') : 'make the change you asked for';
}

export const updateEventTool: ToolDef<typeof updateEventInput> = {
  name: 'update_event',
  description:
    'Updates an event on one account (defaults to the account that holds it). Refused when the event has other guests, because any change would notify them; the result says what to change yourself. Never adds or removes guests.',
  input: updateEventInput,
  kind: 'write',
  async handler(input, ctx) {
    const calendarId = input.calendarId ?? 'primary';
    let found: GEvent | null | undefined;
    const account = await ctx.fanout.resolveWriteAccount(input.account, async () => {
      const { item } = await ctx.fanout.lookup(undefined, (a) =>
        ctx.adapters.calendar(ctx.adapterContext(a)).getEvent({ calendarId, eventId: input.eventId }),
      );
      found = item;
      return item ? ((await ctx.store.accounts.list()).find((a) => a.label === item.account) ?? null) : null;
    });
    await refuseGuestFields(ctx, 'update_event', account, input, input.eventId);

    const adapter = ctx.adapters.calendar(ctx.adapterContext(account));
    const current = found ?? (await adapter.getEvent({ calendarId, eventId: input.eventId }));
    if (!current) throw new ProviderError('not_found', 'No event with that id was found on that account. Nothing was changed.');

    const guests = (current.attendees ?? []).filter((a) => a.self !== true && a.resource !== true).length;
    // Google hides other guests when the list is truncated, or when we are a guest who can't see the others.
    const hidden = current.attendeesOmitted === true || (current.guestsCanSeeOtherGuests === false && current.organizer?.self !== true);
    if (guests > 0 || hidden) {
      await ctx.store.audit.write({ tool: 'update_event', account: account.label, targetId: input.eventId, outcome: 'rejected' });
      throw new GuardrailError(
        'guest_event',
        `This event has other guests${guests > 0 ? ` (${guests})` : ''}, so changing it would notify them. Not changed. To make this change yourself in Google Calendar: ${describeChange(input)}.`,
      );
    }

    const body = toBody(input, typeof current.description === 'string' ? current.description : undefined);
    if (input.addedAttachments || input.removedAttachmentFileUrls) {
      const removed = new Set(input.removedAttachmentFileUrls);
      const kept = ((current.attachments as { fileUrl: string; title?: string }[] | undefined) ?? []).filter((a) => !removed.has(a.fileUrl));
      body.attachments = [...kept, ...(input.addedAttachments ?? [])].map(({ fileUrl, title }) => ({ fileUrl, ...(title ? { title } : {}) }));
    }
    const event = await audited(ctx, 'update_event', account, input.eventId, () =>
      adapter.patchEvent({ calendarId, eventId: input.eventId, body }),
    );
    return tagged(event, account);
  },
};
