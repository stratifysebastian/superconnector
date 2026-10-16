import type { AdapterContext } from '@/core/contracts/adapter';
import type { CalendarAdapter, GCalendarListEntry, GEvent, Page } from '@/core/contracts/calendar';
import { ProviderError } from '@/core/errors';
import { calendarUrl } from './endpoints/urls';

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

const enc = encodeURIComponent;
const eventsPath = (calendarId: string) => `/calendars/${enc(calendarId)}/events`;
const page = <T>(r: ListResponse<T>): Page<T> => ({ items: r.items ?? [], nextPageToken: r.nextPageToken });

export function createLiveCalendarAdapter(ctx: AdapterContext): CalendarAdapter {
  const { http } = ctx;
  return {
    async listCalendars(p) {
      return page(
        await http.json<ListResponse<GCalendarListEntry>>({
          method: 'GET',
          url: calendarUrl('/users/me/calendarList'),
          query: { maxResults: p.pageSize, pageToken: p.pageToken },
        }),
      );
    },

    async listEvents(p) {
      return page(
        await http.json<ListResponse<GEvent>>({
          method: 'GET',
          url: calendarUrl(eventsPath(p.calendarId)),
          query: {
            singleEvents: true, // expand recurring events so each has a real start
            maxResults: p.pageSize,
            pageToken: p.pageToken,
            timeMin: p.timeMin,
            timeMax: p.timeMax,
            q: p.q,
            orderBy: p.orderBy,
            eventTypes: p.eventTypes?.join(','),
            timeZone: p.timeZone,
          },
        }),
      );
    },

    async getEvent(p) {
      try {
        return await http.json<GEvent>({ method: 'GET', url: calendarUrl(`${eventsPath(p.calendarId)}/${enc(p.eventId)}`) });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'not_found') return null;
        throw e;
      }
    },

    async freeBusy(p) {
      const r = await http.json<{ calendars?: Awaited<ReturnType<CalendarAdapter['freeBusy']>> }>({
        method: 'POST',
        url: calendarUrl('/freeBusy'),
        body: { timeMin: p.timeMin, timeMax: p.timeMax, timeZone: p.timeZone, items: p.ids.map((id) => ({ id })) },
      });
      return r.calendars ?? {};
    },

    insertEvent(p) {
      return http.json<GEvent>({
        method: 'POST',
        url: calendarUrl(eventsPath(p.calendarId)),
        query: { sendUpdates: 'none', conferenceDataVersion: p.body.conferenceData ? 1 : undefined },
        body: p.body,
      });
    },

    patchEvent(p) {
      return http.json<GEvent>({
        method: 'PATCH',
        url: calendarUrl(`${eventsPath(p.calendarId)}/${enc(p.eventId)}`),
        query: { sendUpdates: 'none', conferenceDataVersion: p.body.conferenceData ? 1 : undefined },
        body: p.body,
      });
    },
  };
}
