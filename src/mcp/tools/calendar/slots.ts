export interface Interval {
  start: number; // ms epoch
  end: number;
}
export interface SlotQuery {
  busy: Interval[];
  windowStart: number;
  windowEnd: number;
  durationMinutes: number;
  startHour: number; // local hour the day opens (0-24)
  endHour: number; // local hour the day closes (0-24)
  excludeWeekends: boolean;
  /** IANA zone, or a fixed offset in minutes when no zone is known. */
  zone: { timeZone: string } | { offsetMinutes: number };
  limit: number;
}

/** Merges overlapping or touching intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const i of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function offsetAt(ms: number, zone: SlotQuery['zone']): number {
  if ('offsetMinutes' in zone) return zone.offsetMinutes;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone.timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return (Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000) / 60000;
}

/** Fixed offset in minutes from an RFC3339 string ("Z" or "+02:00"), or undefined. */
export function offsetOfIso(s: string): number | undefined {
  if (/Z$/.test(s)) return 0;
  const m = /([+-])(\d\d):?(\d\d)$/.exec(s);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : undefined;
}

export function formatOffset(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** RFC3339 string with the zone's offset at that instant. */
export function formatIso(ms: number, zone: SlotQuery['zone']): string {
  const off = offsetAt(ms, zone);
  return new Date(ms + off * 60000).toISOString().slice(0, 19) + formatOffset(off);
}

/** UTC ms for local wall-clock `hour` on local date y-m-d. */
function localToUtc(y: number, m: number, d: number, hour: number, zone: SlotQuery['zone']): number {
  const wall = Date.UTC(y, m, d, 0, 0, 0) + hour * 3_600_000;
  let guess = wall - offsetAt(wall, zone) * 60000;
  guess = wall - offsetAt(guess, zone) * 60000; // second pass settles DST edges
  return guess;
}

/**
 * Free intervals of at least `durationMinutes` inside the window, restricted per local day to
 * [startHour, endHour) and optionally skipping weekends. Each returned interval is a whole free gap.
 */
export function computeFreeSlots(q: SlotQuery): Interval[] {
  const busy = mergeIntervals(q.busy);
  const out: Interval[] = [];
  const min = q.durationMinutes * 60000;
  const first = new Date(q.windowStart + offsetAt(q.windowStart, q.zone) * 60000);
  let day = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  while (out.length < q.limit) {
    const d = new Date(day);
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
    const open = Math.max(localToUtc(y, m, dd, q.startHour, q.zone), q.windowStart);
    if (open >= q.windowEnd) break;
    const wd = d.getUTCDay();
    if (!(q.excludeWeekends && (wd === 0 || wd === 6))) {
      const close = Math.min(localToUtc(y, m, dd, q.endHour, q.zone), q.windowEnd);
      let cursor = open;
      for (const b of [...busy, { start: close, end: close }]) {
        if (b.end <= cursor) continue;
        const gapEnd = Math.min(b.start, close);
        if (gapEnd - cursor >= min && out.length < q.limit) out.push({ start: cursor, end: gapEnd });
        cursor = Math.max(cursor, b.end);
        if (cursor >= close) break;
      }
    }
    day += 86_400_000;
  }
  return out;
}
