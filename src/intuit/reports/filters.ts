/** The filters the built-in applies after fetching (top_n, min_days_overdue, ...). They run here, on the parsed table. */
import { GuardrailError } from '@/core/errors';
import { dataRows } from './summary';
import { num, refilter, totalCol, type Col, type Row, type Table } from './table';

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const colBy = (t: Table, re: RegExp): Col | undefined => t.cols.find((c) => re.test(c.title));

export interface AgingSummaryFilter {
  /** Exact, case-insensitive for customers; contains, case-insensitive for vendors. */
  name?: string | null;
  exactName: boolean;
  minDaysOverdue?: number | null;
  minOverdueAmount?: number | null;
  topN?: number | null;
}

/** Same restriction as the built-in: only one of min_days_overdue, min_overdue_amount and top_n per call. */
export function agingSummaryFilter(f: AgingSummaryFilter): ((t: Table) => Table) | undefined {
  const given = [f.minDaysOverdue, f.minOverdueAmount, f.topN].filter((x) => x !== undefined && x !== null).length;
  if (given > 1) {
    throw new GuardrailError('filters/one-at-a-time', 'Pass only one of min_days_overdue, min_overdue_amount or top_n per call. Use the most relevant one and answer the rest from the returned data.');
  }
  if (given === 0 && !f.name) return undefined;
  return (t) => {
    const tc = totalCol(t);
    const buckets = t.cols.filter((c) => c.money && c !== tc);
    const lower = (c: Col) => (/^current$/i.test(c.title) ? 0 : Number(/^(\d+)/.exec(c.title)?.[1] ?? Infinity));
    const sum = (r: Row, cols: Col[]) => cols.reduce((a, c) => a + (num(r.cells[c.idx]) ?? 0), 0);
    let rows = dataRows(t);
    if (f.name) rows = rows.filter((r) => (f.exactName ? norm(r.cells[0]) === norm(f.name!) : norm(r.cells[0]).includes(norm(f.name!))));
    if (typeof f.minDaysOverdue === 'number') {
      const min = f.minDaysOverdue;
      const cols = min <= 0 ? buckets.filter((c) => lower(c) === 0) : buckets.filter((c) => lower(c) >= min);
      rows = rows.filter((r) => sum(r, cols) !== 0);
    }
    if (typeof f.minOverdueAmount === 'number') {
      const min = f.minOverdueAmount;
      const overdue = buckets.filter((c) => lower(c) > 0);
      rows = rows.filter((r) => sum(r, overdue) >= min);
    }
    if (typeof f.topN === 'number' && tc) {
      const n = Math.max(0, Math.floor(f.topN));
      rows = [...rows].sort((a, b) => (num(b.cells[tc.idx]) ?? 0) - (num(a.cells[tc.idx]) ?? 0)).slice(0, n);
    }
    const keep = new Set(rows);
    return refilter(t, (r) => keep.has(r), rows);
  };
}

export interface AgingDetailFilter {
  /** Exact, case-insensitive on the Customer column. */
  customerName?: string | null;
  /** Contains, case-insensitive on the Vendor column. */
  vendorName?: string | null;
  transactionType?: string | null;
  /** YYYY-MM-DD; inclusive. A future cutoff also drops bills already overdue. */
  dueBefore?: string | null;
  today: string;
}

export function agingDetailFilter(f: AgingDetailFilter): ((t: Table) => Table) | undefined {
  if (!f.customerName && !f.vendorName && !f.transactionType && !f.dueBefore) return undefined;
  return (t) => {
    const who = colBy(t, /^(customer|vendor)$/i);
    const type = colBy(t, /^(transaction )?type$/i);
    const due = colBy(t, /^due date$/i);
    return refilter(t, (r) => {
      if (f.customerName && who && norm(r.cells[who.idx]) !== norm(f.customerName)) return false;
      if (f.vendorName && who && !norm(r.cells[who.idx]).includes(norm(f.vendorName))) return false;
      if (f.transactionType && type && norm(r.cells[type.idx]) !== norm(f.transactionType)) return false;
      if (f.dueBefore && due) {
        const d = r.cells[due.idx];
        if (!d || d > f.dueBefore) return false;
        if (f.dueBefore > f.today && d < f.today) return false;
      }
      return true;
    });
  };
}

export interface ItemSalesFilter {
  productNames?: string[] | null;
  topN?: number | null;
  bottomN?: number | null;
  sortBy?: string | null;
  column?: string | null;
  op?: string | null;
  threshold?: number | null;
}

const COLUMN_ALIASES: [RegExp, RegExp][] = [
  [/^amount$/i, /^amount$/i],
  [/^qty$|^quantity$/i, /^qty$|^quantity$/i],
  [/^% of sales$/i, /^% of sales$/i],
  [/^avg price$|^average price$/i, /^avg|^average/i],
];
const columnFor = (t: Table, name: string): Col | undefined => {
  const alias = COLUMN_ALIASES.find(([a]) => a.test(name.trim()));
  return t.cols.find((c) => c.numeric && (alias ? alias[1].test(c.title) : norm(c.title) === norm(name)));
};

export function itemSalesFilter(f: ItemSalesFilter): ((t: Table) => Table) | undefined {
  const value = [f.column, f.op, f.threshold].filter((x) => x !== undefined && x !== null);
  if (value.length > 0 && value.length < 3) throw new GuardrailError('filters/value', 'value_filter_column, value_filter_op and value_filter_threshold must all be given together.');
  if (f.topN != null && f.bottomN != null) throw new GuardrailError('filters/top-bottom', 'top_n and bottom_n cannot be used together.');
  if (value.length === 3 && !['gt', 'gte', 'lt', 'lte', 'eq'].includes(f.op!)) throw new GuardrailError('filters/op', 'value_filter_op must be one of gt, gte, lt, lte or eq.');
  const names = (f.productNames ?? []).map(norm).filter(Boolean);
  if (!names.length && !value.length && f.topN == null && f.bottomN == null && !f.sortBy) return undefined;
  return (t) => {
    let rows = dataRows(t);
    if (names.length) rows = rows.filter((r) => names.some((n) => norm(r.cells[0]).includes(n)));
    if (value.length === 3) {
      const c = columnFor(t, f.column!);
      if (!c) throw new GuardrailError('filters/column', `This report has no "${f.column}" column to filter on.`);
      const cmp: Record<string, (a: number, b: number) => boolean> = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };
      rows = rows.filter((r) => cmp[f.op!]!(num(r.cells[c.idx]) ?? 0, f.threshold!));
    }
    const by = columnFor(t, f.sortBy || 'Amount');
    const val = (r: Row) => (by ? (num(r.cells[by.idx]) ?? 0) : 0);
    if (f.topN != null) rows = [...rows].sort((a, b) => val(b) - val(a)).slice(0, Math.max(0, f.topN));
    else if (f.bottomN != null) rows = [...rows].sort((a, b) => val(a) - val(b)).slice(0, Math.max(0, f.bottomN));
    else if (f.sortBy) rows = [...rows].sort((a, b) => val(b) - val(a));
    const keep = new Set(rows);
    return refilter(t, (r) => keep.has(r), rows);
  };
}
