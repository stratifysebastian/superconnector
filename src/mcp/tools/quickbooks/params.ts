import { GuardrailError } from '@/core/errors';
import type { QbReportParams } from '@/core/contracts/quickbooks';

type Ymd = [y: number, m: number, d: number];
const parse = (s: string): Ymd => s.split('-').map(Number) as Ymd;
const fmt = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => {
  const [y, m, d] = parse(s);
  return fmt(y, m, d + n);
};
const lastDay = (y: number, m: number): string => fmt(y, m + 1, 0);

/** Weeks run Monday to Sunday. */
const monday = (s: string): string => {
  const [y, m, d] = parse(s);
  return addDays(s, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
};
const quarterStart = (m: number): number => m - ((m - 1) % 3);

/**
 * date_range macros -> explicit calendar dates (the Reports API's own macros are never sent: some are fiscal, some
 * undocumented). "Quarter" and "year" are calendar periods. `t` is today in the company's time zone.
 */
const MACROS: Record<string, (t: string) => [string, string]> = {
  TODAY: (t) => [t, t],
  THIS_WEEK: (t) => [monday(t), addDays(monday(t), 6)],
  THIS_WEEK_TO_DATE: (t) => [monday(t), t],
  LAST_WEEK: (t) => [addDays(monday(t), -7), addDays(monday(t), -1)],
  THIS_MONTH: (t) => { const [y, m] = parse(t); return [fmt(y, m, 1), lastDay(y, m)]; },
  THIS_MONTH_TO_DATE: (t) => { const [y, m] = parse(t); return [fmt(y, m, 1), t]; },
  LAST_MONTH: (t) => { const [y, m] = parse(t); return [fmt(y, m - 1, 1), lastDay(y, m - 1)]; },
  THIS_QUARTER: (t) => { const [y, m] = parse(t); const q = quarterStart(m); return [fmt(y, q, 1), lastDay(y, q + 2)]; },
  THIS_QUARTER_TO_DATE: (t) => { const [y, m] = parse(t); return [fmt(y, quarterStart(m), 1), t]; },
  LAST_QUARTER: (t) => { const [y, m] = parse(t); const q = quarterStart(m) - 3; return [fmt(y, q, 1), lastDay(y, q + 2)]; },
  THIS_YEAR: (t) => { const [y] = parse(t); return [fmt(y, 1, 1), fmt(y, 12, 31)]; },
  THIS_YEAR_TO_DATE: (t) => { const [y] = parse(t); return [fmt(y, 1, 1), t]; },
  LAST_YEAR: (t) => { const [y] = parse(t); return [fmt(y - 1, 1, 1), fmt(y - 1, 12, 31)]; },
  // Same month and day last year (29 February becomes 28 February).
  LAST_YEAR_TO_DATE: (t) => { const [y, m, d] = parse(t); return [fmt(y - 1, 1, 1), fmt(y - 1, m, Math.min(d, parse(lastDay(y - 1, m))[2]))]; },
  LAST_30_DAYS: (t) => [addDays(t, -30), t],
  THIS_30_DAYS: (t) => [addDays(t, -30), t],
  LAST_90_DAYS: (t) => [addDays(t, -90), t],
  LAST_12_MONTHS: (t) => [addDays(t, -365), t],
};
// shortcut: fiscal-year macros are read as calendar years because the fiscal start month is not known; add it when a company needs it.
MACROS.THIS_FISCAL_YEAR = MACROS.THIS_YEAR!;
MACROS.THIS_FISCAL_YEAR_TO_DATE = MACROS.THIS_YEAR_TO_DATE!;
MACROS.LAST_FISCAL_YEAR = MACROS.LAST_YEAR!;
const SPLITS: Record<string, string> = { MONTH: 'Month', QUARTER: 'Quarter', YEAR: 'Year', WEEK: 'Week', DAY: 'Days' };

export function isoDate(s: string, what: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  const d = m && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (!m || !d || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]!) throw new GuardrailError('date/format', `${what} must be a real date in YYYY-MM-DD form.`);
  return s.trim();
}

/** Today in the company's time zone (all current companies are Canadian; Toronto). */
export const today = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(now);

export function accountingMethod(v: string | null | undefined): 'accrual' | 'cash' {
  const m = (v ?? 'accrual').trim().toLowerCase();
  if (m !== 'accrual' && m !== 'cash') throw new GuardrailError('accounting_method', 'accounting_method must be "accrual" or "cash".');
  return m;
}

export interface PeriodInput {
  date_range?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  accounting_method?: string | null;
  split_by?: string | null;
}

/**
 * Period inputs -> Reports API parameters, always as explicit start_date/end_date. Start and end must come together; one
 * alone is ignored (as in the built-in) and a note says so.
 */
export function periodParams(
  i: PeriodInput,
  defaults: { macro: string; splitMacro?: string },
  now: Date = new Date(),
): { params: QbReportParams; method: 'accrual' | 'cash'; split: string | null; notes: string[] } {
  const method = accountingMethod(i.accounting_method);
  const split = i.split_by ? SPLITS[i.split_by.trim().toUpperCase()] : undefined;
  if (i.split_by && !split) throw new GuardrailError('split_by', 'split_by must be one of MONTH, QUARTER, YEAR, WEEK or DAY.');
  const out: QbReportParams = {
    accounting_method: method === 'cash' ? 'Cash' : 'Accrual',
    ...(split ? { summarize_column_by: split } : {}),
  };
  const notes: string[] = [];
  if (i.start_date && i.end_date) {
    out.start_date = isoDate(i.start_date, 'start_date');
    out.end_date = isoDate(i.end_date, 'end_date');
  } else {
    if (i.start_date || i.end_date) notes.push(`Only ${i.start_date ? 'start_date' : 'end_date'} was given, so it was ignored; start_date and end_date must be given together.`);
    const key = (i.date_range ?? (split ? (defaults.splitMacro ?? defaults.macro) : defaults.macro)).trim().toUpperCase();
    if (key === 'ALL') throw new GuardrailError('date_range', 'date_range ALL is not supported. Ask for a specific period: pass start_date and end_date, or a range such as THIS_YEAR.');
    const range = MACROS[key];
    if (!range) throw new GuardrailError('date_range', `date_range "${i.date_range}" is not supported. Use one of ${Object.keys(MACROS).join(', ')}, or pass start_date and end_date.`);
    [out.start_date, out.end_date] = range(today(now));
  }
  return { params: out, method, split: i.split_by ? i.split_by.trim().toUpperCase() : null, notes };
}
