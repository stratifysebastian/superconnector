import { GuardrailError } from '@/core/errors';
import type { QbReportParams } from '@/core/contracts/quickbooks';

/** The built-in's date_range macros mapped to the Reports API's date_macro values. */
const MACROS: Record<string, string> = {
  TODAY: 'Today',
  THIS_WEEK: 'This Week',
  THIS_WEEK_TO_DATE: 'This Week-to-date',
  LAST_WEEK: 'Last Week',
  THIS_MONTH: 'This Month',
  THIS_MONTH_TO_DATE: 'This Month-to-date',
  LAST_MONTH: 'Last Month',
  THIS_QUARTER: 'This Fiscal Quarter',
  THIS_QUARTER_TO_DATE: 'This Fiscal Quarter-to-date',
  LAST_QUARTER: 'Last Fiscal Quarter',
  THIS_YEAR: 'This Year',
  THIS_YEAR_TO_DATE: 'This Year-to-date',
  LAST_YEAR: 'Last Year',
  LAST_YEAR_TO_DATE: 'Last Year-to-date',
  THIS_FISCAL_YEAR: 'This Fiscal Year',
  THIS_FISCAL_YEAR_TO_DATE: 'This Fiscal Year-to-date',
  LAST_FISCAL_YEAR: 'Last Fiscal Year',
  LAST_30_DAYS: 'Since 30 Days Ago',
  THIS_30_DAYS: 'Since 30 Days Ago',
  LAST_90_DAYS: 'Since 90 Days Ago',
  LAST_12_MONTHS: 'Since 365 Days Ago',
  ALL: 'All',
};
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
 * Period inputs -> Reports API parameters. Start and end dates must come together (one alone is ignored, as in the
 * built-in); otherwise a date_range macro, otherwise the default.
 */
export function periodParams(i: PeriodInput, defaults: { macro: string; splitMacro?: string }): { params: QbReportParams; method: 'accrual' | 'cash'; split: string | null } {
  const method = accountingMethod(i.accounting_method);
  const split = i.split_by ? SPLITS[i.split_by.trim().toUpperCase()] : undefined;
  if (i.split_by && !split) throw new GuardrailError('split_by', 'split_by must be one of MONTH, QUARTER, YEAR, WEEK or DAY.');
  const out: QbReportParams = {
    accounting_method: method === 'cash' ? 'Cash' : 'Accrual',
    ...(split ? { summarize_column_by: split } : {}),
  };
  if (i.start_date && i.end_date) {
    out.start_date = isoDate(i.start_date, 'start_date');
    out.end_date = isoDate(i.end_date, 'end_date');
  } else {
    const key = (i.date_range ?? (split ? (defaults.splitMacro ?? defaults.macro) : defaults.macro)).trim().toUpperCase();
    const macro = MACROS[key];
    if (!macro) throw new GuardrailError('date_range', `date_range "${i.date_range}" is not supported. Use one of ${Object.keys(MACROS).join(', ')}, or pass start_date and end_date.`);
    out.date_macro = macro;
  }
  return { params: out, method, split: i.split_by ? i.split_by.trim().toUpperCase() : null };
}
