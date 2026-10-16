import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Account } from '@/core/contracts/account';
import type { AdapterContext } from '@/core/contracts/adapter';
import type { CalendarAdapter, GEvent } from '@/core/contracts/calendar';
import { ProviderError } from '@/core/errors';
import { resetMockFaults, setMockFaults } from '@/google/mock/faults';
import { createMockCalendarAdapter, resetMockCalendar } from '@/google/mock/calendar';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  resetMockFaults();
  resetMockCalendar();
});

function adapter(label: 'stratify' | 'prime', signal: AbortSignal = new AbortController().signal): CalendarAdapter {
  const account = { label, email: `seb@${label}.example` } as Account;
  return createMockCalendarAdapter({ account, signal } as unknown as AdapterContext);
}

async function all(a: CalendarAdapter, pageSize: number): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const page = await a.listEvents({ calendarId: 'primary', pageSize, ...(pageToken ? { pageToken } : {}) });
    out.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

describe('mock calendar', () => {
  it('loads both accounts', async () => {
    expect((await adapter('stratify').listCalendars({ pageSize: 10 })).items).toHaveLength(2);
    expect((await adapter('prime').listCalendars({ pageSize: 10 })).items[0]?.id).toBe('seb@prime.example');
    expect(await all(adapter('stratify'), 100)).toHaveLength(12);
    expect(await all(adapter('prime'), 100)).toHaveLength(12);
  });

  it('shares one meeting across accounts with different ids', async () => {
    const s = (await all(adapter('stratify'), 100)).find((e) => e.summary === 'FAKE Quarterly sync')!;
    const p = (await all(adapter('prime'), 100)).find((e) => e.summary === 'FAKE Quarterly sync')!;
    expect(s.iCalUID).toBe(p.iCalUID);
    expect(s.start).toEqual(p.start);
    expect(s.id).not.toBe(p.id);
  });

  it('pages every event exactly once, ordered by start', async () => {
    const a = adapter('stratify');
    const ids: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await a.listEvents({ calendarId: 'primary', pageSize: 5, orderBy: 'startTime', ...(pageToken ? { pageToken } : {}) });
      ids.push(...page.items.map((e) => e.id));
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken);
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(12);
  });

  it('filters by time and q', async () => {
    const a = adapter('stratify');
    const day = await a.listEvents({
      calendarId: 'primary', pageSize: 50,
      timeMin: '2026-10-19T00:00:00-04:00', timeMax: '2026-10-20T00:00:00-04:00',
    });
    expect(day.items.map((e) => e.id).sort()).toEqual(['strat-001', 'strat-002', 'strat-012']);
    const q = await a.listEvents({ calendarId: 'primary', pageSize: 50, q: 'GUEST EVENT' });
    expect(q.items.map((e) => e.id)).toEqual(['strat-005']);
  });

  it('serves the secondary calendar separately and getEvent returns null when missing', async () => {
    const a = adapter('stratify');
    const sec = await a.listEvents({ calendarId: 'team-stratify@group.calendar.example', pageSize: 50 });
    expect(sec.items).toHaveLength(2);
    expect(await a.getEvent({ calendarId: 'primary', eventId: 'strat-001' })).toMatchObject({ id: 'strat-001' });
    expect(await a.getEvent({ calendarId: 'primary', eventId: 'nope' })).toBeNull();
  });

  it('computes freeBusy matching the fixture, and flags unknown ids', async () => {
    const fb = await adapter('prime').freeBusy({
      timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-26T00:00:00Z', ids: ['seb@prime.example', 'primary', 'x@y.example'],
    });
    const fixture = JSON.parse(readFileSync('fixtures/calendar/prime/freebusy.json', 'utf8')) as {
      calendars: Record<string, { busy: unknown[] }>;
    };
    expect(fb['seb@prime.example']?.busy).toEqual(fixture.calendars['seb@prime.example']?.busy);
    expect(fb['primary']?.busy).toHaveLength(11);
    expect(fb['x@y.example']).toEqual({ busy: [], errors: [{ reason: 'notFound' }] });
  });

  it.each([
    ['invalid_grant', 'needs_reconnect'],
    ['rate_limited', 'rate_limited'],
  ] as const)('fault %s becomes %s', async (fault, kind) => {
    setMockFaults({ prime: fault });
    await expect(adapter('prime').listEvents({ calendarId: 'primary', pageSize: 5 })).rejects.toMatchObject({ kind });
    await expect(adapter('stratify').listEvents({ calendarId: 'primary', pageSize: 5 })).resolves.toBeDefined();
  });

  it('timeout fault rejects when the signal aborts', async () => {
    setMockFaults({ prime: 'timeout' });
    const ac = new AbortController();
    const p = adapter('prime', ac.signal).getEvent({ calendarId: 'primary', eventId: 'prime-001' });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(ProviderError);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('keeps writes in memory only and reset clears them', async () => {
    const before = readFileSync('fixtures/calendar/stratify/events.json', 'utf8');
    const a = adapter('stratify');
    const created = await a.insertEvent({ calendarId: 'primary', body: { summary: 'FAKE new', start: { dateTime: '2026-10-21T08:00:00-04:00' }, end: { dateTime: '2026-10-21T08:30:00-04:00' } } });
    expect(created.iCalUID).toBeTruthy();
    const patched = await a.patchEvent({ calendarId: 'primary', eventId: 'strat-001', body: { summary: 'FAKE renamed' } });
    expect(patched.summary).toBe('FAKE renamed');
    expect(await a.getEvent({ calendarId: 'primary', eventId: created.id })).not.toBeNull();
    expect((await all(a, 100)).length).toBe(13);
    expect(readFileSync('fixtures/calendar/stratify/events.json', 'utf8')).toBe(before);
    // the other account is untouched
    expect(await adapter('prime').getEvent({ calendarId: 'primary', eventId: created.id })).toBeNull();
    resetMockCalendar();
    expect(await a.getEvent({ calendarId: 'primary', eventId: created.id })).toBeNull();
    expect((await a.getEvent({ calendarId: 'primary', eventId: 'strat-001' }))?.summary).toBe('FAKE Stratify standup');
  });

  it('rejects attendees on writes', async () => {
    const a = adapter('stratify');
    const bad = { summary: 'x', attendees: [{ email: 'a@b.example' }] };
    await expect(a.insertEvent({ calendarId: 'primary', body: bad })).rejects.toThrow(/attendees/);
    await expect(a.patchEvent({ calendarId: 'primary', eventId: 'strat-001', body: bad })).rejects.toThrow(/attendees/);
  });
});
