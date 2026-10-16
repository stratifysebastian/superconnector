import type { AdapterContext } from '@/core/contracts/adapter';
import type {
  CalendarAdapter,
  EventWriteBody,
  GCalendarListEntry,
  GEvent,
  Page,
} from '@/core/contracts/calendar';
import { loadFixture } from './fixtures';
import { withMockFaults } from './faults';

interface EventsFile {
  items: GEvent[];
}

/** Per-process writes, keyed by account label then event id. Never touches fixture files. */
const written = new Map<string, Map<string, GEvent>>();
let counter = 0;

export function resetMockCalendar(): void {
  written.clear();
  counter = 0;
}

function overlay(label: string): Map<string, GEvent> {
  let m = written.get(label);
  if (!m) written.set(label, (m = new Map()));
  return m;
}

function isPrimary(email: string, calendarId: string): boolean {
  return calendarId === 'primary' || calendarId === email;
}

function eventsFor(label: string, email: string, calendarId: string): GEvent[] {
  const base = loadFixture<EventsFile>('calendar', label, isPrimary(email, calendarId) ? 'events' : 'events-secondary').items;
  if (!isPrimary(email, calendarId)) return base;
  const w = overlay(label);
  return [...base.map((e) => w.get(e.id) ?? e), ...[...w.values()].filter((e) => !base.some((b) => b.id === e.id))];
}

const startMs = (e: GEvent): number => Date.parse(e.start?.dateTime ?? e.start?.date ?? '');
const endMs = (e: GEvent): number => Date.parse(e.end?.dateTime ?? e.end?.date ?? '');

function noAttendees(body: object): void {
  if ('attendees' in body) throw new Error('Mock calendar: attendees are never allowed on writes');
}

export function createMockCalendarAdapter(ctx: AdapterContext): CalendarAdapter {
  const { label, email } = ctx.account;
  const run = <T>(fn: () => T): Promise<T> => withMockFaults(ctx.account, fn, { signal: ctx.signal });

  return {
    listCalendars: ({ pageSize, pageToken }) =>
      run(() => {
        const all = loadFixture<{ items: GCalendarListEntry[] }>('calendar', label, 'calendarList').items;
        return paginate(all, pageSize, pageToken);
      }),

    listEvents: (p) =>
      run(() => {
        let items = eventsFor(label, email, p.calendarId);
        const min = p.timeMin ? Date.parse(p.timeMin) : -Infinity;
        const max = p.timeMax ? Date.parse(p.timeMax) : Infinity;
        items = items.filter((e) => endMs(e) > min && startMs(e) < max);
        if (p.q) {
          const q = p.q.toLowerCase();
          items = items.filter((e) =>
            [e.summary, e.description, e.location].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)),
          );
        }
        if (p.orderBy === 'startTime') items = [...items].sort((a, b) => startMs(a) - startMs(b));
        else if (p.orderBy === 'updated') items = [...items].sort((a, b) => Date.parse(a.updated ?? '') - Date.parse(b.updated ?? ''));
        return paginate(items, p.pageSize, p.pageToken);
      }),

    getEvent: ({ calendarId, eventId }) =>
      run(() => eventsFor(label, email, calendarId).find((e) => e.id === eventId) ?? null),

    freeBusy: ({ timeMin, timeMax, ids }) =>
      run(() => {
        const min = Date.parse(timeMin);
        const max = Date.parse(timeMax);
        const out: Record<string, { busy: { start: string; end: string }[]; errors?: unknown[] }> = {};
        for (const id of ids) {
          if (!isPrimary(email, id)) {
            out[id] = { busy: [], errors: [{ reason: 'notFound' }] };
            continue;
          }
          out[id] = {
            busy: eventsFor(label, email, id)
              .filter((e) => e.start?.dateTime && e.status !== 'cancelled' && e.transparency !== 'transparent')
              .filter((e) => endMs(e) > min && startMs(e) < max)
              .sort((a, b) => startMs(a) - startMs(b))
              .map((e) => ({ start: iso(startMs(e)), end: iso(endMs(e)) })),
          };
        }
        return out;
      }),

    insertEvent: ({ body }) =>
      run(() => {
        noAttendees(body);
        const id = `mock-${label}-${++counter}`;
        const ev: GEvent = {
          kind: 'calendar#event',
          id,
          iCalUID: `${id}@mock.example.test`,
          status: 'confirmed',
          htmlLink: `https://calendar.example.test/event?eid=${id}`,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          organizer: { email, self: true },
          ...(body as EventWriteBody),
        };
        overlay(label).set(id, ev);
        return ev;
      }),

    patchEvent: ({ calendarId, eventId, body }) =>
      run(() => {
        noAttendees(body);
        const cur = eventsFor(label, email, calendarId).find((e) => e.id === eventId);
        if (!cur) throw new Error(`Mock calendar: event not found: ${eventId}`);
        const ev: GEvent = { ...cur, ...(body as EventWriteBody), updated: new Date().toISOString() };
        overlay(label).set(eventId, ev);
        return ev;
      }),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000', '');

/** pageToken is base64 of the offset. */
function paginate<T>(all: T[], pageSize: number, pageToken?: string): Page<T> {
  const offset = pageToken ? Number.parseInt(Buffer.from(pageToken, 'base64').toString('utf8'), 10) || 0 : 0;
  const items = all.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  return next < all.length ? { items, nextPageToken: Buffer.from(String(next)).toString('base64') } : { items };
}
