import type { QbReportName } from '@/core/contracts/quickbooks';
import { amountOf, fmtMoney, num, round2, totalCol, type Row, type Table } from './table';

export type ReportKind = QbReportName | 'ItemList';

export interface Summary {
  /** The report-specific totals object that goes into the widget JSON. */
  data: Record<string, unknown>;
  /** The same totals as label/value pairs for the text variants' "### Summary" bullets. */
  lines: [string, string][];
}

/** The summary row (or, failing that, the header row) of a section, by its group, else by its label. */
function pick(t: Table, groups: string[], label?: RegExp): Row | undefined {
  for (const g of groups) {
    const r = t.rows.find((x) => x.kind === 'summary' && x.group === g) ?? t.rows.find((x) => x.group === g && x.kind === 'data');
    if (r) return r;
  }
  return label ? t.rows.find((x) => x.kind !== 'header' && label.test(x.cells[0] ?? '')) : undefined;
}
const amt = (t: Table, groups: string[], label?: RegExp): number | null => amountOf(t, pick(t, groups, label));
const pct = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : Math.round((a / b) * 1000) / 10);
const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : round2(a / b));

/** The rows directly under a section: nested sections (their totals) and plain lines. */
function breakdown(t: Table, summaryRow: Row | undefined): { name: string; amount: number | null }[] {
  const parent = summaryRow?.parentId;
  if (!parent) return [];
  return t.rows
    .filter((r) => r.parentId === parent && r.kind !== 'summary')
    .map((r) => {
      const total = r.kind === 'header' ? t.rows.find((s) => s.kind === 'summary' && s.parentId === r.id) : r;
      return { name: r.cells[0] ?? '', amount: amountOf(t, total) };
    });
}

/** The ordinary data rows a ranking or an aging summary works on. */
export const dataRows = (t: Table): Row[] => t.rows.filter((r) => r.kind === 'data');

function sumCol(t: Table, rows: Row[], idx: number): number {
  return round2(rows.reduce((a, r) => a + (num(r.cells[idx]) ?? 0), 0));
}

export function summarize(name: ReportKind, t: Table, opts: { topN?: number; ranking?: 'top' | 'bottom' } = {}): Summary {
  const f = (n: number | null) => fmtMoney(n, t.currency);
  const lines: [string, string][] = [];
  const line = (label: string, n: number | null) => {
    if (n !== null) lines.push([label, f(n)]);
  };
  const data: Record<string, unknown> = {};

  switch (name) {
    case 'ItemList': {
      const rows = dataRows(t);
      const byType: Record<string, number> = {};
      for (const r of rows) byType[r.cells[1] || 'Other'] = (byType[r.cells[1] || 'Other'] ?? 0) + 1;
      Object.assign(data, { itemCount: rows.length, byType });
      lines.push(['Products and services', String(rows.length)]);
      break;
    }
    case 'BalanceSheet': {
      const assets = pick(t, ['TotalAssets'], /^total assets$/i);
      const liab = pick(t, ['Liabilities'], /^total liabilities$/i);
      const equity = pick(t, ['Equity'], /^total (?:shareholders?'?s? )?equity$/i);
      const [ta, tl, te] = [amountOf(t, assets), amountOf(t, liab), amountOf(t, equity)];
      const ca = amt(t, ['CurrentAssets'], /^total current assets$/i);
      const cl = amt(t, ['CurrentLiabilities'], /^total current liabilities$/i);
      Object.assign(data, {
        totalAssets: ta,
        totalLiabilities: tl,
        totalEquity: te,
        assetBreakdown: breakdown(t, assets),
        liabilityBreakdown: breakdown(t, liab),
        ratios: { currentRatio: ratio(ca, cl), workingCapital: ca !== null && cl !== null ? round2(ca - cl) : null, debtToEquity: ratio(tl, te) },
      });
      line('Total assets', ta);
      line('Total liabilities', tl);
      line('Total equity', te);
      break;
    }
    case 'ProfitAndLoss': {
      const income = amt(t, ['Income'], /^total income$/i);
      const cogs = amt(t, ['COGS'], /^total cost of goods sold$/i);
      const gross = amt(t, ['GrossProfit'], /^gross profit$/i);
      const exp = amt(t, ['Expenses'], /^total expenses$/i);
      const noi = amt(t, ['NetOperatingIncome'], /^net operating income$/i);
      const net = amt(t, ['NetIncome'], /^net income$/i);
      Object.assign(data, {
        totalIncome: income, totalCogs: cogs, grossProfit: gross, totalExpenses: exp, netOperatingIncome: noi, netIncome: net,
        grossMarginPercent: pct(gross, income), netMarginPercent: pct(net, income),
      });
      line('Total income', income);
      line('Cost of goods sold', cogs);
      line('Gross profit', gross);
      line('Total expenses', exp);
      line('Net operating income', noi);
      line('Net income', net);
      if (data.netMarginPercent !== null) lines.push(['Net margin', `${data.netMarginPercent}%`]);
      break;
    }
    case 'CashFlow': {
      const op = amt(t, ['OperatingActivities'], /^net cash provided by operating activities$/i);
      const inv = amt(t, ['InvestingActivities'], /^net cash provided by investing activities$/i);
      const fin = amt(t, ['FinancingActivities'], /^net cash provided by financing activities$/i);
      const inc = amt(t, ['CashIncrease', 'NetCashIncrease'], /^net cash increase for period$/i);
      const begin = amt(t, ['BeginningCash'], /^cash at beginning of period$/i);
      const end = amt(t, ['EndingCash', 'CashAtEnd'], /^cash at end of period$/i);
      Object.assign(data, { operatingActivities: op, investingActivities: inv, financingActivities: fin, netCashIncrease: inc, cashAtBeginning: begin, cashAtEnd: end });
      line('Operating activities', op);
      line('Investing activities', inv);
      line('Financing activities', fin);
      line('Net cash increase', inc);
      line('Cash at end of period', end);
      break;
    }
    case 'AgedReceivables':
    case 'AgedPayables': {
      const ar = name === 'AgedReceivables';
      const tc = totalCol(t);
      const buckets = t.cols.filter((c) => c.money && c !== tc);
      const rows = dataRows(t);
      const bucketTotals = Object.fromEntries(buckets.map((b) => [b.title, sumCol(t, rows, b.idx)]));
      const total = tc ? sumCol(t, rows, tc.idx) : null;
      const current = buckets.find((b) => /^current$/i.test(b.title));
      const totalCurrent = current ? sumCol(t, rows, current.idx) : null;
      const overdueOf = (r: Row) => buckets.filter((b) => b !== current).reduce((a, b) => a + (num(r.cells[b.idx]) ?? 0), 0);
      const totalOverdue = total !== null && totalCurrent !== null ? round2(total - totalCurrent) : null;
      const top = rows
        .map((r) => ({ name: r.cells[0] ?? '', overdue: round2(overdueOf(r)), total: tc ? (num(r.cells[tc.idx]) ?? 0) : 0 }))
        .filter((x) => x.overdue > 0)
        .sort((a, b) => b.overdue - a.overdue)
        .slice(0, 5);
      const who = ar ? 'customer' : 'vendor';
      const overduePercent = pct(totalOverdue, total);
      Object.assign(data, {
        [ar ? 'totalReceivables' : 'totalPayables']: total,
        totalCurrent,
        totalOverdue,
        overduePercent,
        bucketTotals,
        [`${who}Count`]: rows.length,
        [ar ? 'topOverdueCustomers' : 'topOverdueVendors']: top.map((x) => ({ [who]: x.name, overdue: x.overdue, total: x.total })),
        [ar ? 'customersByBucket' : 'vendorsByBucket']: Object.fromEntries(buckets.map((b) => [b.title, rows.filter((r) => (num(r.cells[b.idx]) ?? 0) !== 0).length])),
        metricCards: [
          { label: ar ? 'Total receivables' : 'Total payables', value: f(total) },
          { label: 'Overdue', value: f(totalOverdue) },
          { label: 'Overdue share', value: overduePercent === null ? '' : `${overduePercent}%` },
        ],
      });
      line(ar ? 'Total receivables' : 'Total payables', total);
      line('Current', totalCurrent);
      line('Overdue', totalOverdue);
      if (overduePercent !== null) lines.push(['Overdue share', `${overduePercent}%`]);
      lines.push([ar ? 'Customers' : 'Vendors', String(rows.length)]);
      break;
    }
    case 'AgedReceivableDetail':
    case 'AgedPayableDetail': {
      const rows = dataRows(t);
      const open = t.cols.find((c) => c.money && /open balance/i.test(c.title)) ?? totalCol(t);
      const total = open ? sumCol(t, rows, open.idx) : null;
      const byBucket = t.rows
        .filter((r) => r.kind === 'header' && r.depth === 0)
        .map((h) => {
          const inside = rows.filter((d) => d.id.startsWith(`${h.id}.`));
          return { bucket: h.cells[0] ?? '', count: inside.length, total: open ? sumCol(t, inside, open.idx) : null };
        });
      Object.assign(data, { transactionCount: rows.length, totalOpenBalance: total, byBucket });
      lines.push(['Transactions', String(rows.length)]);
      line('Total open balance', total);
      break;
    }
    case 'CustomerSales':
    case 'ItemSales': {
      const tc = totalCol(t);
      const rows = dataRows(t);
      const amountCol = name === 'ItemSales' ? (t.cols.find((c) => c.money && /^amount$/i.test(c.title)) ?? tc) : tc;
      const val = (r: Row) => (amountCol ? (num(r.cells[amountCol.idx]) ?? 0) : 0);
      const total = amountCol ? sumCol(t, rows, amountCol.idx) : null;
      const ordered = [...rows].sort((a, b) => (opts.ranking === 'bottom' ? val(a) - val(b) : val(b) - val(a)));
      const ranking = ordered.slice(0, opts.topN ?? 10).map((r, i) => ({ rank: i + 1, name: r.cells[0] ?? '', amount: val(r), percentOfTotal: pct(val(r), total) }));
      Object.assign(data, { totalSales: total, [name === 'CustomerSales' ? 'customerCount' : 'productCount']: rows.length, ...(name === 'CustomerSales' ? { ranking: { order: opts.ranking ?? 'top', rows: ranking } } : {}) });
      line('Total sales', total);
      lines.push([name === 'CustomerSales' ? 'Customers' : 'Products and services', String(rows.length)]);
      break;
    }
  }
  return { data, lines };
}
