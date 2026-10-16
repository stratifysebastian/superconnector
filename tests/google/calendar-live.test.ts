import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '@/core/contracts/adapter';
import { GuardrailError } from '@/core/errors';
import { createLiveCalendarAdapter } from '@/google/calendar';
import { ENDPOINT_RULES } from '@/google/endpoints';
import { createGoogleHttp } from '@/google/http';

const API = 'https://www.googleapis.com/calendar/v3';

function setup(responses: Response[] = []) {
  const calls: { url: URL; method: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return responses.shift() ?? new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const http = createGoogleHttp({ getAccessToken: async () => 'tok', fetchImpl, rules: ENDPOINT_RULES, sleep: async () => {} });
  const adapter = createLiveCalendarAdapter({ http } as unknown as AdapterContext);
  return { http, adapter, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const q = (u: URL) => Object.fromEntries(u.searchParams);

describe('live calendar adapter', () => {
  it('listCalendars', async () => {
    const { adapter, calls } = setup([json({ items: [{ id: 'a' }], nextPageToken: 'n' })]);
    expect(await adapter.listCalendars({ pageSize: 5, pageToken: 'p' })).toEqual({ items: [{ id: 'a' }], nextPageToken: 'n' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/calendar/v3/users/me/calendarList');
    expect(q(calls[0]!.url)).toEqual({ maxResults: '5', pageToken: 'p' });
  });

  it('listEvents expands recurrences and maps params', async () => {
    const { adapter, calls } = setup([json({ items: [{ id: 'e' }] })]);
    const out = await adapter.listEvents({
      calendarId: 'a@b.com', pageSize: 10, q: 'x', timeMin: 't1', timeMax: 't2', orderBy: 'startTime', eventTypes: ['default', 'focusTime'],
    });
    expect(out.items).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/calendar/v3/calendars/a%40b.com/events');
    expect(q(calls[0]!.url)).toEqual({
      singleEvents: 'true', maxResults: '10', q: 'x', timeMin: 't1', timeMax: 't2', orderBy: 'startTime', eventTypes: 'default,focusTime',
    });
  });

  it('getEvent returns the event, or null on 404', async () => {
    const { adapter, calls } = setup([json({ id: 'e@1' }), json({ error: {} }, 404)]);
    expect(await adapter.getEvent({ calendarId: 'primary', eventId: 'e@1' })).toEqual({ id: 'e@1' });
    expect(calls[0]!.url.pathname).toBe('/calendar/v3/calendars/primary/events/e%401');
    expect(await adapter.getEvent({ calendarId: 'primary', eventId: 'gone' })).toBeNull();
  });

  it('freeBusy posts items and returns calendars', async () => {
    const { adapter, calls } = setup([json({ calendars: { x: { busy: [] } } })]);
    expect(await adapter.freeBusy({ timeMin: 'a', timeMax: 'b', ids: ['x'] })).toEqual({ x: { busy: [] } });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/calendar/v3/freeBusy');
    expect(calls[0]!.url.search).toBe('');
    expect(calls[0]!.body).toEqual({ timeMin: 'a', timeMax: 'b', items: [{ id: 'x' }] });
  });

  it('insertEvent and patchEvent always send sendUpdates=none', async () => {
    const { adapter, calls } = setup();
    await adapter.insertEvent({ calendarId: 'primary', body: { summary: 's' } });
    await adapter.patchEvent({ calendarId: 'primary', eventId: 'e1', body: { summary: 't' } });
    await adapter.insertEvent({ calendarId: 'primary', body: { conferenceData: { createRequest: {} } } });
    expect(calls.map((c) => [c.method, c.url.pathname, q(c.url)])).toEqual([
      ['POST', '/calendar/v3/calendars/primary/events', { sendUpdates: 'none' }],
      ['PATCH', '/calendar/v3/calendars/primary/events/e1', { sendUpdates: 'none' }],
      ['POST', '/calendar/v3/calendars/primary/events', { sendUpdates: 'none', conferenceDataVersion: '1' }],
    ]);
  });
});

describe('calendar policy', () => {
  const ev = `${API}/calendars/primary/events`;
  const none = { sendUpdates: 'none' };

  it('rejects an events POST without sendUpdates', async () => {
    const { http, calls } = setup();
    await expect(http.json({ method: 'POST', url: ev, body: { summary: 's' } })).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('rejects attendees (even cast through any) and unknown body keys', async () => {
    const { http, calls } = setup();
    const body = { summary: 's', attendees: [{ email: 'x@y.z' }] } as unknown;
    await expect(http.json({ method: 'POST', url: ev, query: none, body })).rejects.toBeInstanceOf(GuardrailError);
    await expect(http.json({ method: 'POST', url: ev, query: none, body: { id: 'custom' } })).rejects.toBeInstanceOf(GuardrailError);
    await expect(
      http.json({ method: 'POST', url: `${API}/freeBusy`, body: { timeMin: 'a', timeMax: 'b', items: [{ id: 'x', extra: 1 }] } }),
    ).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('rejects status cancelled on PATCH', async () => {
    const { http, calls } = setup();
    await expect(http.json({ method: 'PATCH', url: `${ev}/e1`, query: none, body: { status: 'cancelled' } })).rejects.toBeInstanceOf(GuardrailError);
    expect(calls).toHaveLength(0);
  });

  it('rejects calendar clear, DELETE and excluded endpoints', async () => {
    const { http, calls } = setup();
    const bad = [
      { method: 'POST', url: `${API}/calendars/primary/clear` },
      { method: 'DELETE', url: `${ev}/e1` },
      { method: 'POST', url: `${ev}/quickAdd`, query: none },
      { method: 'POST', url: `${ev}/e1/move`, query: none },
      { method: 'POST', url: `${ev}/import`, query: none },
      { method: 'POST', url: `${ev}/watch`, query: none },
      { method: 'GET', url: `${API}/calendars/primary/acl` },
      { method: 'GET', url: `${ev}/e1/instances` },
    ];
    for (const r of bad) {
      await expect(http.json(r as never)).rejects.toBeInstanceOf(GuardrailError);
    }
    expect(calls).toHaveLength(0);
  });
});
