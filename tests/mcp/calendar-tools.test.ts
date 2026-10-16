import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { CalendarAdapter, EventWriteBody, GEvent } from '@/core/contracts/calendar';
import type { ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { GuardrailError, ProviderError } from '@/core/errors';
import { getToolDefs, type AnyToolDef } from '@/mcp/registry';
import { computeFreeSlots } from '@/mcp/tools/calendar/slots';
import { assertNoExcludedTools } from '../contract/excluded';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';

const acct = (label: string, priority: number): Account => ({
  id: `id-${label}`,
  provider: 'google',
  email: `seb@${label}.test`,
  label,
  orgClientId: 'org',
  priority,
  connectedAt: '2026-01-01T00:00:00Z',
  status: 'active',
  grantedScopes: [],
});
const accounts = [acct('stratify', 0), acct('prime', 1)];

const ev = (id: string, start: string, extra: Partial<GEvent> = {}): GEvent => ({
  id,
  iCalUID: `${id}@g`,
  summary: id,
  start: { dateTime: start },
  end: { dateTime: start },
  ...extra,
});

interface Fake extends CalendarAdapter {
  events: GEvent[];
  busy: { start: string; end: string }[];
  fail?: ProviderError;
}
let fakes: Record<string, Fake>;
let audit: { tool: string; account: string; targetId?: string; outcome: string }[];
let ctx: ToolContext;

function makeFake(label: string): Fake {
  const f: Fake = {
    events: [],
    busy: [],
    listCalendars: vi.fn(async () => {
      if (f.fail) throw f.fail;
      return { items: [{ id: `${label}-cal`, summary: label, timeZone: 'UTC', primary: true }] };
    }),
    listEvents: vi.fn(async (p) => {
      if (f.fail) throw f.fail;
      const start = Number(p.pageToken ?? 0);
      const all = p.orderBy === 'startTime' ? [...f.events].sort((a, b) => Date.parse(a.start!.dateTime!) - Date.parse(b.start!.dateTime!)) : f.events;
      const items = all.slice(start, start + p.pageSize);
      const next = start + p.pageSize;
      return { items, ...(next < f.events.length ? { nextPageToken: String(next) } : {}) };
    }),
    getEvent: vi.fn(async (p) => f.events.find((e) => e.id === p.eventId) ?? null),
    freeBusy: vi.fn(async (p) => Object.fromEntries(p.ids.map((id: string) => [id, { busy: id === 'primary' ? f.busy : [] }]))),
    insertEvent: vi.fn(async (p) => ({ id: 'new1', summary: p.body.summary })),
    patchEvent: vi.fn(async (p) => ({ id: p.eventId, ...p.body }) as GEvent),
  };
  return f;
}

beforeEach(() => {
  fakes = { stratify: makeFake('stratify'), prime: makeFake('prime') };
  audit = [];
  ctx = {
    store: { accounts: { list: async () => accounts }, audit: { write: async (e: (typeof audit)[number]) => void audit.push(e) } },
    fanout: createFanOutEngine({ listAccounts: async () => accounts, cursorSecret: 's'.repeat(32), reconnectUrl: '/connect' }),
    adapters: { calendar: (c: { account: Account }) => fakes[c.account.label]! },
    adapterContext: (account: Account) => ({ account }),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ToolContext;
});

const tool = (name: string): AnyToolDef => getToolDefs('http://x').find((d) => d.name === name)!;
const call = (name: string, args: Record<string, unknown> = {}) => {
  const def = tool(name);
  return def.handler(def.input.parse(args) as never, ctx) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe('registry', () => {
  it('registers exactly the eight enabled names and no excluded tool', () => {
    const names = getToolDefs('http://x').map((d) => d.name);
    expect([...names].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(ENABLED_TOOL_NAMES).toHaveLength(8);
    expect(() => assertNoExcludedTools(names)).not.toThrow();
  });
});

describe('reads', () => {
  beforeEach(() => {
    const shared = { iCalUID: 'meet@g' };
    fakes.stratify!.events = [ev('s1', '2026-10-20T10:00:00Z'), ev('sm', '2026-10-19T09:00:00Z', shared)];
    fakes.prime!.events = [
      ev('p1', '2026-10-21T10:00:00Z', { hangoutLink: 'https://meet.example/abc' }),
      ev('pm', '2026-10-19T09:00:00Z', shared),
    ];
  });

  it('merges earliest first and collapses the shared meeting', async () => {
    const r = await call('list_events', { startTime: '2026-10-01T00:00:00Z', endTime: '2026-11-01T00:00:00Z' });
    expect(r.events.map((e: GEvent) => e.id)).toEqual(['sm', 's1', 'p1']);
    expect(r.events[2].conferenceUrl).toBe('https://meet.example/abc');
    expect(r.events[0]).toMatchObject({ account: 'stratify', accounts: ['stratify', 'prime'] });
    expect(r.events[0].sources).toEqual([
      { account: 'stratify', id: 'sm', calendarId: 'primary' },
      { account: 'prime', id: 'pm', calendarId: 'primary' },
    ]);
    expect(r.accountErrors).toEqual([]);
    expect(fakes.stratify!.listEvents).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'primary' }));
  });

  it('reports a disconnected account in accountErrors', async () => {
    fakes.prime!.fail = new ProviderError('needs_reconnect', 'invalid_grant');
    const r = await call('list_events', {});
    expect(r.events.map((e: GEvent) => e.id)).toEqual(['sm', 's1']);
    expect(r.accountErrors).toHaveLength(1);
    expect(r.accountErrors[0]).toMatchObject({ account: 'prime', kind: 'needs_reconnect' });
  });

  it('round-trips the cursor', async () => {
    const first = await call('list_events', { pageSize: 2 });
    expect(first.events.map((e: GEvent) => e.id)).toEqual(['sm', 's1']);
    expect(first.nextCursor).toBeTruthy();
    const second = await call('list_events', { pageSize: 2, pageToken: first.nextCursor });
    expect(second.events.map((e: GEvent) => e.id)).toEqual(['p1']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('search_events queries the primary calendar with q and orderBy startTime', async () => {
    await call('search_events', { query: 'lunch' });
    expect(fakes.stratify!.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'primary', q: 'lunch', orderBy: 'startTime', timeMin: expect.any(String) }),
    );
  });

  it('list_calendars tags each calendar with its account', async () => {
    const r = await call('list_calendars', {});
    expect(r.calendars.map((c: { account: string }) => c.account)).toEqual(['stratify', 'prime']);
    expect(r.calendars[0]).toMatchObject({ id: 'stratify-cal', primary: true, accountEmail: 'seb@stratify.test' });
    expect(r.accountErrors).toEqual([]);
  });

  it('get_event finds the event in the second account, or says it is missing', async () => {
    const hit = await call('get_event', { eventId: 'p1' });
    expect(hit).toMatchObject({ id: 'p1', account: 'prime', accountEmail: 'seb@prime.test' });
    const miss = await call('get_event', { eventId: 'nope' });
    expect(miss.message).toMatch(/No event/);
  });
});

describe('computeFreeSlots', () => {
  const t = (s: string) => Date.parse(s);
  const base = {
    windowStart: t('2026-10-19T00:00:00Z'),
    windowEnd: t('2026-10-20T00:00:00Z'),
    durationMinutes: 30,
    startHour: 9,
    endHour: 17,
    excludeWeekends: false,
    zone: { offsetMinutes: 0 },
    limit: 10,
  };
  it('merges overlapping busy time and keeps gaps of at least the duration', () => {
    const slots = computeFreeSlots({
      ...base,
      busy: [
        { start: t('2026-10-19T09:00:00Z'), end: t('2026-10-19T10:00:00Z') },
        { start: t('2026-10-19T09:30:00Z'), end: t('2026-10-19T11:00:00Z') },
        { start: t('2026-10-19T11:15:00Z'), end: t('2026-10-19T16:00:00Z') },
      ],
    });
    expect(slots.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()])).toEqual([
      ['2026-10-19T16:00:00.000Z', '2026-10-19T17:00:00.000Z'],
    ]);
    expect(computeFreeSlots({ ...base, durationMinutes: 15, busy: [{ start: t('2026-10-19T09:00:00Z'), end: t('2026-10-19T11:00:00Z') }, { start: t('2026-10-19T11:15:00Z'), end: t('2026-10-19T17:00:00Z') }] })).toHaveLength(1);
  });
  it('uses the zone for day hours and skips weekends', () => {
    // Sydney is UTC+11 in October: 09:00-17:00 local = 22:00Z-06:00Z. 2026-10-24 is a Saturday.
    const slots = computeFreeSlots({
      ...base,
      windowStart: t('2026-10-22T00:00:00Z'),
      windowEnd: t('2026-10-26T13:00:00Z'),
      zone: { timeZone: 'Australia/Sydney' },
      excludeWeekends: true,
      busy: [],
    });
    const days = slots.map((s) => new Date(s.start + 11 * 3600000).toISOString().slice(0, 10));
    expect(days).toEqual(['2026-10-22', '2026-10-23', '2026-10-26']);
    expect(new Date(slots[0]!.start).toISOString()).toBe('2026-10-22T00:00:00.000Z'); // clipped to the window start (11:00 Sydney)
    expect(slots[1]!.end - slots[1]!.start).toBe(8 * 3600000);
  });
  it('respects the limit', () => {
    expect(computeFreeSlots({ ...base, windowEnd: t('2026-10-30T00:00:00Z'), limit: 3, busy: [] })).toHaveLength(3);
  });
});

describe('suggest_time', () => {
  const win = { startTime: '2026-10-19T00:00:00+00:00', endTime: '2026-10-20T00:00:00+00:00', attendeeEmails: ['guest@x.test', 'seb@prime.test'] };
  beforeEach(() => {
    fakes.stratify!.busy = [{ start: '2026-10-19T09:00:00Z', end: '2026-10-19T11:00:00Z' }];
    fakes.prime!.busy = [{ start: '2026-10-19T10:00:00Z', end: '2026-10-19T13:00:00Z' }];
  });
  it('unions busy time across accounts and returns the built-in shape', async () => {
    const r = await call('suggest_time', win);
    expect(r.timeSlots).toEqual([
      {
        start: { dateTime: '2026-10-19T13:00:00+00:00', timeZone: '+00:00' },
        end: { dateTime: '2026-10-19T17:00:00+00:00', timeZone: '+00:00' },
        startTime: '2026-10-19T13:00:00+00:00',
        endTime: '2026-10-19T17:00:00+00:00',
        durationMinutes: 240,
      },
    ]);
    expect(r.accountErrors).toEqual([]);
    // The account's own email is not queried as an attendee.
    expect(fakes.prime!.freeBusy).toHaveBeenCalledWith(expect.objectContaining({ ids: ['primary', 'guest@x.test'] }));
  });
  it('honours durationMinutes, hour preferences and pageSize', async () => {
    expect((await call('suggest_time', { ...win, durationMinutes: 300 })).timeSlots).toEqual([]);
    const r = await call('suggest_time', { ...win, preferences: { startHour: 12, endHour: 15 } });
    expect(r.timeSlots.map((s: { startTime: string; endTime: string }) => [s.startTime, s.endTime])).toEqual([
      ['2026-10-19T13:00:00+00:00', '2026-10-19T15:00:00+00:00'],
    ]);
  });
  it('excludes weekends', async () => {
    const r = await call('suggest_time', {
      ...win,
      startTime: '2026-10-24T00:00:00+00:00', // Saturday
      endTime: '2026-10-26T00:00:00+00:00',
      preferences: { excludeWeekends: true },
    });
    expect(r.timeSlots).toEqual([]);
  });
  it('names an account that failed', async () => {
    fakes.prime!.freeBusy = vi.fn(async () => {
      throw new ProviderError('needs_reconnect', 'x');
    });
    const r = await call('suggest_time', win);
    expect(r.accountErrors[0]).toMatchObject({ account: 'prime', kind: 'needs_reconnect' });
    expect(r.timeSlots[0].startTime).toBe('2026-10-19T11:00:00+00:00');
  });
});

describe('create_event', () => {
  const base = { account: 'stratify', summary: 'Lunch', startTime: '2026-10-20T12:00:00+11:00', endTime: '2026-10-20T13:00:00+11:00' };
  it.each([
    ['attendees', [{ email: 'a@x.test' }]],
    ['attendeeEmails', ['a@x.test']],
    ['guestPermissions', { guestsCanInviteOthers: true }],
  ])('refuses %s and never calls the adapter', async (key, value) => {
    await expect(call('create_event', { ...base, [key]: value })).rejects.toBeInstanceOf(GuardrailError);
    await expect(call('create_event', { ...base, [key]: value })).rejects.toThrow(/never invites anyone/);
    expect(fakes.stratify!.insertEvent).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ tool: 'create_event', account: 'stratify', outcome: 'rejected' });
  });
  it('asks which account when none is given', async () => {
    const noAccount: Record<string, unknown> = { ...base };
    delete noAccount.account;
    await expect(call('create_event', noAccount)).rejects.toThrow(/Which one: stratify or prime/);
    expect(fakes.stratify!.insertEvent).not.toHaveBeenCalled();
  });
  it('maps fields, audits, and sends no attendee keys', async () => {
    const r = await call('create_event', {
      ...base,
      availability: 'free',
      recurrenceData: ['RRULE:FREQ=DAILY'],
      overrideReminders: [{ method: 'popup', minutes: 10 }],
      addGoogleMeetUrl: true,
      notificationLevel: 'ALL',
      description: 'With Bob',
    });
    expect(r).toMatchObject({ id: 'new1', account: 'stratify' });
    const arg = vi.mocked(fakes.stratify!.insertEvent).mock.calls[0]![0] as { calendarId: string; body: EventWriteBody };
    expect(arg.calendarId).toBe('primary');
    expect(arg.body).toMatchObject({
      summary: 'Lunch',
      transparency: 'transparent',
      recurrence: ['RRULE:FREQ=DAILY'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      conferenceData: { createRequest: { requestId: expect.any(String) } },
      description: 'With Bob',
    });
    expect(Object.keys(arg.body).join()).not.toMatch(/attend|guest|notif|sendUpdates/i);
    expect(audit).toEqual([{ tool: 'create_event', account: 'stratify', targetId: 'new1', outcome: 'ok' }]);
  });
  it('maps allDay to date and appends the Meet URL to the description', async () => {
    await call('create_event', { ...base, allDay: true, startTime: '2026-10-20', endTime: '2026-10-21', description: 'x', googleMeetUrl: 'https://meet.example/q' });
    const body = vi.mocked(fakes.stratify!.insertEvent).mock.calls[0]![0].body;
    expect(body.start).toEqual({ date: '2026-10-20' });
    expect(body.description).toBe('x\nhttps://meet.example/q');
  });
});

describe('update_event', () => {
  const guestEvent = ev('g1', '2026-10-20T10:00:00Z', {
    attendees: [{ email: 'seb@prime.test', self: true }, { email: 'secret.one@x.test' }, { email: 'secret.two@x.test' }],
  });
  const soloEvent = ev('solo', '2026-10-20T10:00:00Z', {
    attendees: [{ email: 'seb@prime.test', self: true }, { email: 'room@x.test', resource: true }],
  });
  beforeEach(() => {
    fakes.prime!.events = [guestEvent, soloEvent];
  });
  it('refuses a guest event, describes the change and leaks no emails', async () => {
    const p = call('update_event', { account: 'prime', eventId: 'g1', startTime: '2026-10-21T15:00:00+11:00', endTime: '2026-10-21T16:00:00+11:00' });
    await expect(p).rejects.toBeInstanceOf(GuardrailError);
    const err = (await p.catch((e: Error) => e)) as Error;
    expect(err.message).toContain('other guests (2)');
    expect(err.message).toContain('move it to 2026-10-21, 3:00–4:00 PM');
    expect(err.message).not.toMatch(/secret|@/);
    expect(fakes.prime!.patchEvent).not.toHaveBeenCalled();
    expect(audit.at(-1)).toMatchObject({ tool: 'update_event', account: 'prime', outcome: 'rejected' });
  });
  it.each([
    ['the guest list is truncated', { attendeesOmitted: true }],
    ['other guests are hidden from us', { attendees: [{ email: 'seb@prime.test', self: true }], guestsCanSeeOtherGuests: false, organizer: { email: 'boss@x.test' } }],
  ])('refuses when %s', async (_, extra) => {
    fakes.prime!.events = [ev('h1', '2026-10-20T10:00:00Z', extra as Partial<GEvent>)];
    await expect(call('update_event', { account: 'prime', eventId: 'h1', summary: 'x' })).rejects.toBeInstanceOf(GuardrailError);
    expect(fakes.prime!.patchEvent).not.toHaveBeenCalled();
  });
  it('rejects event types that can auto-decline invitations', () => {
    expect(() => tool('create_event').input.parse({ summary: 'x', startTime: 't', endTime: 't', eventType: 'outOfOffice' })).toThrow();
  });
  it('patches only the provided fields on a solo event', async () => {
    const r = await call('update_event', { account: 'prime', eventId: 'solo', summary: 'Renamed' });
    expect(fakes.prime!.patchEvent).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'solo', body: { summary: 'Renamed' } });
    expect(r).toMatchObject({ id: 'solo', account: 'prime' });
    expect(audit).toEqual([{ tool: 'update_event', account: 'prime', targetId: 'solo', outcome: 'ok' }]);
  });
  it('finds the event\'s account when none is given', async () => {
    await call('update_event', { eventId: 'solo', location: 'Cafe' });
    expect(fakes.prime!.patchEvent).toHaveBeenCalled();
    expect(fakes.stratify!.patchEvent).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ account: 'prime', outcome: 'ok' });
  });
  it('asks which account when the event is nowhere', async () => {
    await expect(call('update_event', { eventId: 'nope', summary: 'x' })).rejects.toThrow(/Which one/);
  });
  it.each(['attendees', 'attendeeEmails', 'addedAttendees', 'addedAttendeeEmails', 'removedAttendeeEmails', 'guestPermissions'])(
    'refuses %s',
    async (key) => {
      const value = key === 'guestPermissions' ? { canSeeOtherGuests: false } : ['a@x.test'];
      await expect(call('update_event', { account: 'prime', eventId: 'solo', [key]: value })).rejects.toThrow(/never invites anyone/);
      expect(fakes.prime!.patchEvent).not.toHaveBeenCalled();
      expect(audit[0]).toMatchObject({ outcome: 'rejected' });
    },
  );
});
