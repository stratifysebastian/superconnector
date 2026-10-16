import type { QbReport } from '@/core/contracts/quickbooks';
import type { ReportKind } from './summary';
import { summarize, type Summary } from './summary';
import { fmtMoney, num, toTable, totalCol, type Col, type Row, type Table } from './table';

export interface ReportMeta {
  title: string;
  labelKey: string;
  /** A snapshot (as of a date) rather than a period. */
  asOf: boolean;
  /** Statements show the Total column plus a monthly breakdown; the others show every column. */
  statement: boolean;
}
export const REPORT_META: Record<ReportKind, ReportMeta> = {
  ItemList: { title: 'Product/Service List', labelKey: 'Name', asOf: true, statement: false },
  BalanceSheet: { title: 'Balance Sheet', labelKey: 'ACCOUNT_NAME', asOf: true, statement: true },
  ProfitAndLoss: { title: 'Profit and Loss', labelKey: 'ACCOUNT_NAME', asOf: false, statement: true },
  CashFlow: { title: 'Statement of Cash Flows', labelKey: 'ACCOUNT_NAME', asOf: false, statement: true },
  AgedReceivables: { title: 'A/R Aging Summary', labelKey: 'Customer', asOf: true, statement: false },
  AgedReceivableDetail: { title: 'A/R Aging Detail', labelKey: 'Date', asOf: true, statement: false },
  AgedPayables: { title: 'A/P Aging Summary', labelKey: 'Vendor', asOf: true, statement: false },
  AgedPayableDetail: { title: 'A/P Aging Detail', labelKey: 'Date', asOf: true, statement: false },
  CustomerSales: { title: 'Sales by Customer Summary', labelKey: 'Customer', asOf: false, statement: false },
  ItemSales: { title: 'Sales by Product/Service Summary', labelKey: 'Product/Service', asOf: false, statement: false },
};

export interface Rendered {
  name: ReportKind;
  table: Table;
  summary: Summary;
  title: string;
  accountingMethod: 'accrual' | 'cash';
  /** "2026-01-01 to 2026-10-16" or the as-of date. */
  when: string;
  asOf: boolean;
  splitBy: string | null;
  company: string;
  notes: string[];
}

export interface PrepareOptions {
  /** Applied to the parsed table before summaries (the client-side filters). */
  transform?: (t: Table) => Table;
  company: string;
  requestedMethod: 'accrual' | 'cash';
  splitBy?: string | null;
  topN?: number;
  ranking?: 'top' | 'bottom';
  notes?: string[];
}

/** Reports API JSON -> the shared intermediate form both the widget JSON and the text are made from. */
export function prepare(name: ReportKind, report: QbReport, o: PrepareOptions): Rendered {
  const meta = REPORT_META[name];
  const parsed = toTable(report);
  const table = o.transform ? o.transform(parsed) : parsed;
  const h = table.header;
  const method = h.Option?.find((x) => x.Name === 'AccountingMethod')?.Value?.toLowerCase();
  const end = h.EndPeriod ?? h.StartPeriod ?? '';
  return {
    name,
    table,
    summary: summarize(name, table, { topN: o.topN, ranking: o.ranking }),
    title: meta.title,
    accountingMethod: method === 'cash' || method === 'accrual' ? method : o.requestedMethod,
    when: meta.asOf || !h.StartPeriod || !h.EndPeriod ? end : `${h.StartPeriod} to ${h.EndPeriod}`,
    asOf: meta.asOf,
    splitBy: o.splitBy ?? null,
    company: o.company,
    notes: o.notes ?? [],
  };
}

const colName = (c: Col, meta: ReportMeta, t: Table): string => {
  if (c.idx === 0) return meta.labelKey;
  if (c.money && c === totalCol(t) && c.key === 'total') return 'DETAIL_NATURAL_HOME_AMOUNT__TOTAL';
  return c.title.replace(/\s*-\s*/g, '-');
};

/** The interactive-widget JSON shape: reportTitle, reportData.rows[].cells[]/depth/metadata, displayColumns, summary, period or asOf. */
export function toWidget(r: Rendered): Record<string, unknown> {
  const meta = REPORT_META[r.name];
  const { table: t } = r;
  const names = t.cols.map((c) => colName(c, meta, t));
  const rows = t.rows.map((row) => ({
    cells: t.cols.map((c) => {
      const raw = row.cells[c.idx] ?? '';
      const n = c.numeric ? num(raw) : null;
      return {
        id: `${row.id}:${c.idx}`,
        name: names[c.idx],
        value: c.numeric ? n : raw === '' ? null : raw,
        localizedValue: c.numeric ? (n === null ? null : c.money ? fmtMoney(n, t.currency) : String(n)) : null,
        cells: null,
      };
    }),
    depth: row.depth,
    metadata: {
      id: row.id,
      parentId: row.parentId,
      pageStart: null,
      pageEnd: null,
      ...(row.kind === 'header' ? { type: ['GROUP'] } : row.kind === 'summary' ? { type: ['SUMMARY'] } : {}),
    },
  }));
  return {
    reportTitle: r.title,
    reportData: { rows },
    displayColumns: t.cols.map((c, i) => ({ key: names[i], displayField: c.numeric ? 'localizedValue' : 'value' })),
    summary: r.summary.data,
    ...(r.asOf ? { asOf: r.when } : { period: r.when }),
    accountingMethod: r.accountingMethod,
    ...(r.name === 'BalanceSheet' ? { splitBy: r.splitBy } : {}),
    ...(r.notes.length ? { notes: r.notes } : {}),
    // No reportLink: QuickBooks has no stable deep link to a report that we can build and verify.
  };
}

const NBSP = '&nbsp;&nbsp;';
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
/** Summary rows sit one level deeper in the tree but line up with their section header on screen. */
const shown = (r: Row) => (r.kind === 'summary' && r.parentId !== '' ? r.depth - 1 : r.depth);

function cellText(c: Col, r: Row, t: Table): string {
  const raw = r.cells[c.idx] ?? '';
  return c.money ? fmtMoney(num(raw), t.currency) : c.numeric ? (num(raw) ?? '').toString() : raw;
}

/** Markdown in the built-in's text shape: STATUS, title, header line, Summary bullets, Line Items, optional Monthly Breakdown. */
export function toText(r: Rendered): string {
  const meta = REPORT_META[r.name];
  const { table: t } = r;
  const total = totalCol(t);
  const money = t.cols.filter((c) => c.money);
  const out: string[] = ['STATUS: success', '', `## ${r.title}`, ''];
  out.push(`**${[r.asOf ? `As of ${r.when}` : r.when, `${r.accountingMethod === 'cash' ? 'Cash' : 'Accrual'} basis`, r.company].filter(Boolean).join(' · ')}**`, '');
  if (r.summary.lines.length) out.push('### Summary', ...r.summary.lines.map(([k, v]) => `- ${k}: ${v}`), '');
  for (const n of r.notes) out.push(`_${n}_`, '');

  const lineCols = meta.statement ? [t.cols[0]!, ...(total ? [total] : [])] : t.cols;
  out.push('### Line Items');
  if (r.name === 'ProfitAndLoss') {
    // The built-in prints the P&L as a fenced text block.
    const w = Math.max(10, ...t.rows.map((x) => shown(x) * 2 + (x.cells[0] ?? '').length));
    out.push('```text');
    for (const x of t.rows) {
      const label = `${' '.repeat(shown(x) * 2)}${(x.cells[0] ?? '').replace(/`/g, "'")}`;
      out.push(total && x.kind !== 'header' ? `${label.padEnd(w)}  ${cellText(total, x, t).padStart(14)}`.trimEnd() : label);
    }
    out.push('```');
  } else {
    out.push(`| ${lineCols.map((c) => esc(c.idx === 0 ? (REPORT_HEADING[r.name] ?? (c.title || 'Account')) : meta.statement ? 'Amount' : c.title || 'Amount')).join(' | ')} |`);
    out.push(`|${lineCols.map((c) => (c.numeric ? '---:' : '---')).join('|')}|`);
    for (const x of t.rows) {
      const cells = lineCols.map((c) => (c.idx === 0 ? `${NBSP.repeat(shown(x))}${esc(x.cells[0] ?? '')}` : x.kind === 'header' ? '' : esc(cellText(c, x, t))));
      out.push(`| ${cells.join(' | ')} |`);
    }
  }
  const periods = money.filter((c) => c !== total);
  if (meta.statement && periods.length > 0) {
    out.push('', '### Monthly Breakdown');
    const cols = [t.cols[0]!, ...money];
    out.push(`| ${cols.map((c) => esc(c.title || 'Account')).join(' | ')} |`, `|${cols.map((c) => (c.numeric ? '---:' : '---')).join('|')}|`);
    for (const x of t.rows.filter((y) => y.kind === 'summary')) out.push(`| ${cols.map((c) => esc(cellText(c, x, t))).join(' | ')} |`);
  }
  return out.join('\n');
}

const REPORT_HEADING: Partial<Record<ReportKind, string>> = {
  BalanceSheet: 'Account',
  CashFlow: 'Account',
  AgedReceivables: 'Customer',
  AgedPayables: 'Vendor',
  CustomerSales: 'Customer',
  ItemSales: 'Product/Service',
};
