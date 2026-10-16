/**
 * Reports API JSON (Header, Columns, Rows with nested Row/Rows/Summary) flattened into one table.
 * Every report goes through this and render.ts; there is no per-report converter.
 */
import type { QbReport, QbReportRow } from '@/core/contracts/quickbooks';

export interface Col {
  idx: number;
  title: string;
  /** Intuit's ColKey metadata (e.g. "total"), lower-cased; '' when absent. */
  key: string;
  /** Currency amounts (ColType Money). */
  money: boolean;
  /** Money or plain numbers (ColType Numeric): the cell has a numeric value. */
  numeric: boolean;
}
export interface Row {
  /** Dotted path ("1.2.1"); a section header takes the section's number, its rows are children of it. */
  id: string;
  parentId: string;
  depth: number;
  kind: 'header' | 'data' | 'summary';
  /** The section's `group` (e.g. "Income", "TotalAssets"); set on its header and summary rows. */
  group?: string;
  /** One string per column. */
  cells: string[];
  /** The QuickBooks id of the row's entity, when Intuit gives one. */
  refId?: string;
}
export interface Table {
  cols: Col[];
  rows: Row[];
  currency: string;
  header: NonNullable<QbReport['Header']>;
}

export function toTable(report: QbReport): Table {
  const cols: Col[] = (report.Columns?.Column ?? []).map((c, idx) => ({
    idx,
    title: c.ColTitle ?? '',
    key: (c.MetaData?.find((m) => m.Name === 'ColKey')?.Value ?? '').toLowerCase(),
    money: c.ColType === 'Money',
    numeric: c.ColType === 'Money' || c.ColType === 'Numeric',
  }));
  const rows: Row[] = [];
  const cellsOf = (d?: { value?: string }[]) => cols.map((_, i) => d?.[i]?.value ?? '');
  const walk = (list: QbReportRow[] | undefined, prefix: string, parentId: string, depth: number) => {
    (list ?? []).forEach((r, i) => {
      const id = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (r.Header || r.Rows || r.Summary) {
        const hasHeader = !!r.Header;
        if (hasHeader) rows.push({ id, parentId, depth, kind: 'header', ...(r.group ? { group: r.group } : {}), cells: cellsOf(r.Header?.ColData), ...ref(r.Header?.ColData) });
        const kids = r.Rows?.Row ?? [];
        walk(kids, id, hasHeader ? id : parentId, hasHeader ? depth + 1 : depth);
        if (r.Summary) {
          const s = hasHeader ? { id: `${id}.${kids.length + 1}`, parentId: id, depth: depth + 1 } : { id, parentId, depth };
          rows.push({ ...s, kind: 'summary', ...(r.group ? { group: r.group } : {}), cells: cellsOf(r.Summary.ColData) });
        }
      } else {
        rows.push({ id, parentId, depth, kind: 'data', ...(r.group ? { group: r.group } : {}), cells: cellsOf(r.ColData), ...ref(r.ColData) });
      }
    });
  };
  walk(report.Rows?.Row, '', '', 0);
  return { cols, rows, currency: report.Header?.Currency || 'CAD', header: report.Header ?? {} };
}

const ref = (d?: { id?: string }[]): { refId?: string } => (d?.[0]?.id ? { refId: d[0].id } : {});

/** "1234.50" -> 1234.5; empty or non-numeric -> null. */
export function num(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+(\.\d+)?$/.test(s.trim())) return null;
  return Number(s);
}
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The column whose figure stands for the row: ColKey "total", else the last money column. */
export function totalCol(t: Table): Col | undefined {
  const money = t.cols.filter((c) => c.money);
  return money.find((c) => c.key === 'total') ?? money[money.length - 1];
}
export const amountOf = (t: Table, r: Row | undefined): number | null => {
  const c = totalCol(t);
  return r && c ? num(r.cells[c.idx]) : null;
};

export function fmtMoney(n: number | null, currency: string): string {
  if (n === null) return '';
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

/**
 * Keeps the data rows `keep` accepts. Section headers and summaries with nothing left are dropped, and every
 * remaining summary is re-added from the data rows it covers, so filtered totals match what is shown.
 * `order` (a ranking) puts the kept data rows in that order, in the places data rows already occupy.
 * shortcut: that assumes a flat list of rows; under category sections they would swap sections. Revisit if a company groups items.
 */
export function refilter(t: Table, keep: (r: Row) => boolean, order?: Row[]): Table {
  const data = t.rows.filter((r) => r.kind === 'data' && keep(r));
  const under = (prefix: string) => data.filter((d) => prefix === '' || d.id.startsWith(`${prefix}.`));
  const rows: Row[] = [];
  for (const r of t.rows) {
    if (r.kind === 'data') {
      if (data.includes(r)) rows.push(r);
    } else if (r.kind === 'header') {
      if (under(r.id).length > 0) rows.push(r);
    } else {
      const scope = under(r.parentId);
      // A grand total (no parent) always stays, at zero if need be.
      if (scope.length === 0 && r.parentId !== '') continue;
      const cells = r.cells.map((c, i) => {
        if (!t.cols[i]?.money) return c;
        const vals = scope.map((d) => num(d.cells[i]));
        return vals.every((v) => v === null) ? '' : round2(vals.reduce<number>((a, v) => a + (v ?? 0), 0)).toFixed(2);
      });
      rows.push({ ...r, cells });
    }
  }
  if (order) {
    const slots = rows.flatMap((r, i) => (r.kind === 'data' ? [i] : []));
    const ranked = order.filter((r) => rows.includes(r));
    slots.forEach((slot, i) => (rows[slot] = ranked[i]!));
  }
  return { ...t, rows };
}
