import type { EndpointRule } from './policy';

const HOST = 'www.googleapis.com';
const BASE = String.raw`^/calendar/v3`;

/** Mirrors EventWriteBody (src/core/contracts/calendar.ts); anything else is rejected. */
const EVENT_WRITE_KEYS = [
  'summary', 'description', 'location', 'start', 'end', 'recurrence', 'colorId', 'visibility', 'transparency',
  'eventType', 'reminders', 'conferenceData', 'attachments', 'workingLocationProperties',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkEventBody(body: unknown): string | null {
  if (!isObj(body)) return 'event body must be a JSON object';
  const bad = Object.keys(body).find((k) => !EVENT_WRITE_KEYS.includes(k));
  if (bad) return `event field "${bad}" is not allowed`;
  if (body.eventType !== undefined && body.eventType !== 'default' && body.eventType !== 'workingLocation') return 'eventType must be default or workingLocation';
  return null;
}

function checkFreeBusyBody(body: unknown): string | null {
  if (!isObj(body)) return 'freeBusy body must be a JSON object';
  const bad = Object.keys(body).find((k) => !['timeMin', 'timeMax', 'timeZone', 'items'].includes(k));
  if (bad) return `freeBusy field "${bad}" is not allowed`;
  const items = body.items;
  if (items !== undefined && (!Array.isArray(items) || items.some((i) => !isObj(i) || Object.keys(i).some((k) => k !== 'id')))) {
    return 'freeBusy items must be [{ id }]';
  }
  return null;
}

const WRITE_QUERY = ['conferenceDataVersion', 'sendUpdates'];

export const CALENDAR_RULES: EndpointRule[] = [
  { id: 'calendar.calendarList.list', product: 'calendar', method: 'GET', host: HOST, path: new RegExp(`${BASE}/users/me/calendarList$`), allowedQuery: ['maxResults', 'pageToken'] },
  {
    id: 'calendar.events.list', product: 'calendar', method: 'GET', host: HOST, path: new RegExp(`${BASE}/calendars/[^/]+/events$`),
    allowedQuery: ['maxResults', 'pageToken', 'timeMin', 'timeMax', 'q', 'orderBy', 'singleEvents', 'eventTypes', 'timeZone'],
  },
  { id: 'calendar.events.get', product: 'calendar', method: 'GET', host: HOST, path: new RegExp(`${BASE}/calendars/[^/]+/events/[^/]+$`), allowedQuery: ['timeZone'] },
  { id: 'calendar.freebusy.query', product: 'calendar', method: 'POST', host: HOST, path: new RegExp(`${BASE}/freeBusy$`), allowedQuery: [], checkBody: checkFreeBusyBody },
  {
    id: 'calendar.events.insert', product: 'calendar', method: 'POST', host: HOST, path: new RegExp(`${BASE}/calendars/[^/]+/events$`),
    allowedQuery: WRITE_QUERY, requiredQuery: { sendUpdates: 'none' }, checkBody: checkEventBody,
  },
  {
    id: 'calendar.events.patch', product: 'calendar', method: 'PATCH', host: HOST, path: new RegExp(`${BASE}/calendars/[^/]+/events/[^/]+$`),
    allowedQuery: WRITE_QUERY, requiredQuery: { sendUpdates: 'none' }, checkBody: checkEventBody,
  },
];
