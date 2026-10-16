import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QbReport, QbReportName } from '../../src/core/contracts/quickbooks';
import { GuardrailError } from '../../src/core/errors';
import { agingDetailFilter, agingSummaryFilter, itemSalesFilter } from '../../src/intuit/reports/filters';
import { prepare, toText, toWidget } from '../../src/intuit/reports/render';
import { toTable } from '../../src/intuit/reports/table';

const fx = (n: string): QbReport => JSON.parse(readFileSync(`fixtures/quickbooks/stratify-ca/${n}.json`, 'utf8'));
const o = { company: 'Stratify Software Canada Inc.', requestedMethod: 'accrual' as const };
const widget = (name: QbReportName, f: string, over = {}) => toWidget(prepare(name, fx(f), { ...o, ...over })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (name: QbReportName, f: string, over = {}) => toText(prepare(name, fx(f), { ...o, ...over }));

const ALL: [QbReportName, string][] = [
  ['BalanceSheet', 'balance_sheet'], ['ProfitAndLoss', 'profit_loss'], ['CashFlow', 'cash_flow'], ['AgedReceivables', 'ar_aging_summary'],
  ['AgedReceivableDetail', 'ar_aging_detail'], ['AgedPayables', 'ap_aging_summary'], ['AgedPayableDetail', 'ap_aging_detail'], ['CustomerSales', 'customer_sales'], ['ItemSales', 'item_sales'],
];

describe('one converter, every report', () => {
  it.each(ALL)('%s: widget shape, dotted ids, parent links and columns', (name, f) => {
    const w = widget(name, f);
    expect(Object.keys(w)).toEqual(expect.arrayContaining(['reportTitle', 'reportData', 'displayColumns', 'summary', 'accountingMethod']));
    expect('period' in w || 'asOf' in w).toBe(true);
    for (const k of ['next_actions', 'userId', 'realmId', 'reportLink']) expect(w).not.toHaveProperty(k);
    const rows = w.reportData.rows as { cells: { id: string; name: string; cells: null }[]; depth: number; metadata: { id: string; parentId: string; pageStart: null; pageEnd: null } }[];
    expect(rows.length).toBeGreaterThan(2);
    const ids = rows.map((r) => r.metadata.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) {
      expect(r.metadata.id).toMatch(/^\d+(\.\d+)*$/);
      if (r.metadata.parentId) expect(ids).toContain(r.metadata.parentId);
      if (r.metadata.parentId) expect(r.metadata.id.startsWith(`${r.metadata.parentId}.`)).toBe(true);
      expect(r.cells).toHaveLength(w.displayColumns.length);
      expect(r.cells.every((c) => c.cells === null)).toBe(true);
    }
    expect(w.displayColumns.map((c: { key: string }) => c.key)).toEqual(rows[0]!.cells.map((c) => c.name));
    expect(w.displayColumns[0]).toEqual({ key: expect.any(String), displayField: 'value' });
  });

  it.each(ALL)('%s: text shape without next steps or presentation instructions', (name, f) => {
    const t = text(name, f);
    const lines = t.split('\n');
    expect(lines[0]).toBe('STATUS: success');
    expect(lines[2]).toMatch(/^## .+/);
    expect(lines[4]).toMatch(/^\*\*.+Accrual basis · Stratify Software Canada Inc\.\*\*$/);
    expect(t).toContain('### Summary');
    expect(t).toContain('### Line Items');
    expect(t).not.toMatch(/Next steps|present|verbatim/i);
    expect(t).toContain('$');
  });

  it('balance sheet: asOf, totals balance, breakdowns and ratios', () => {
    const w = widget('BalanceSheet', 'balance_sheet', { splitBy: null });
    expect(w).toMatchObject({ reportTitle: 'Balance Sheet', asOf: '2026-10-16', accountingMethod: 'accrual', splitBy: null });
    const s = w.summary;
    expect(s.totalAssets).toBe(104697.56 + 312.49);
    expect(Math.round((s.totalLiabilities + s.totalEquity) * 100) / 100).toBe(s.totalAssets);
    expect(s.assetBreakdown.map((x: { name: string }) => x.name)).toEqual(['Current Assets', 'Fixed Assets']);
    expect(s.liabilityBreakdown.map((x: { name: string }) => x.name)).toEqual(['Current Liabilities', 'Long-Term Liabilities']);
    expect(s.ratios.currentRatio).toBeGreaterThan(1);
    expect(s.ratios.debtToEquity).toBeCloseTo(s.totalLiabilities / s.totalEquity, 2);
    const t = text('BalanceSheet', 'balance_sheet');
    expect(t).toContain('| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Chequing (CAD) | $48,210.55 |');
    expect(t).toContain('| Account | Amount |');
    expect(t).not.toContain('Monthly Breakdown');
  });

  it('profit and loss: period, totals, margins, fenced line items and monthly breakdown', () => {
    const w = widget('ProfitAndLoss', 'profit_loss');
    expect(w.period).toBe('2026-08-01 to 2026-10-16');
    expect(w.summary).toMatchObject({ totalIncome: 59143, totalCogs: 12315, grossProfit: 46828, totalExpenses: 47970, netOperatingIncome: -1142, netIncome: -1034 });
    expect(w.summary.netMarginPercent).toBeCloseTo(-1.7, 1);
    const t = text('ProfitAndLoss', 'profit_loss');
    expect(t).toContain('### Line Items\n```text\nIncome\n  Consulting Services');
    expect(t).toContain('### Monthly Breakdown\n| Account | Aug 2026 | Sep 2026 | Oct 2026 | Total |');
  });

  it('cash flow: operating, investing, financing and cash at the end', () => {
    const s = widget('CashFlow', 'cash_flow').summary;
    expect(s).toMatchObject({ operatingActivities: -2308.25, investingActivities: -4800, financingActivities: -1500, netCashIncrease: -8608.25, cashAtBeginning: 31000, cashAtEnd: 22391.75 });
    expect(Math.round((s.cashAtBeginning + s.netCashIncrease) * 100) / 100).toBe(s.cashAtEnd);
  });

  it('A/R and A/P aging summaries: bucket totals, overdue, top overdue, counts', () => {
    const ar = widget('AgedReceivables', 'ar_aging_summary').summary;
    expect(ar).toMatchObject({ totalReceivables: 22487, totalCurrent: 12656, totalOverdue: 9831, overduePercent: 43.7, customerCount: 5 });
    expect(ar.bucketTotals).toMatchObject({ Current: 12656, '1 - 30': 2260, '91 and over': 2825 });
    expect(ar.topOverdueCustomers[0]).toEqual({ customer: 'Maple Leaf Logistics Inc.', overdue: 3390, total: 10170 });
    expect(ar.metricCards.map((c: { label: string }) => c.label)).toEqual(['Total receivables', 'Overdue', 'Overdue share']);
    const ap = widget('AgedPayables', 'ap_aging_summary').summary;
    expect(ap).toMatchObject({ totalPayables: 8491.5, vendorCount: 4 });
    expect(ap.topOverdueVendors.map((v: { vendor: string }) => v.vendor)).toEqual(['Cloudcore Hosting Inc.', 'Hartley & Co. CPA']);
    expect(widget('AgedReceivableDetail', 'ar_aging_detail').summary).toMatchObject({ transactionCount: 8, totalOpenBalance: 22487 });
    expect(widget('AgedPayableDetail', 'ap_aging_detail').summary.byBucket.map((b: { bucket: string }) => b.bucket)).toEqual(['Current', '1 - 30 days past due', '61 - 90 days past due']);
  });

  it('sales by customer ranks top and bottom; sales by product totals', () => {
    const top = widget('CustomerSales', 'customer_sales', { topN: 2, ranking: 'top' }).summary;
    expect(top.totalSales).toBe(113623.36);
    expect(top.ranking.rows.map((r: { name: string }) => r.name)).toEqual(['Acme Corporation', 'Maple Leaf Logistics Inc.']);
    expect(widget('CustomerSales', 'customer_sales', { topN: 1, ranking: 'bottom' }).summary.ranking.rows[0].name).toBe('Harbourfront Dental Group');
    expect(widget('ItemSales', 'item_sales').summary).toMatchObject({ totalSales: 113623.36, productCount: 5 });
  });

  it('formats money as Canadian dollars', () => {
    const cell = widget('BalanceSheet', 'balance_sheet').reportData.rows[3].cells[1];
    expect(cell).toMatchObject({ value: expect.any(Number), localizedValue: expect.stringMatching(/^\$[\d,]+\.\d{2}$/) });
  });
});

describe('Reports API edge shapes', () => {
  const R = (over: Partial<QbReport>): QbReport => ({ Header: { Currency: 'CAD', EndPeriod: '2026-10-16' }, Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] }] }, ...over });

  it('a report with no Rows, no Row list, or no Columns converts without throwing', () => {
    for (const r of [R({}), R({ Rows: {} }), R({ Rows: { Row: [] } }), { Header: {} }, {}]) {
      const p = prepare('ProfitAndLoss', r as QbReport, o);
      expect(toWidget(p).reportData).toEqual({ rows: [] });
      expect(toText(p)).toContain('STATUS: success');
    }
  });
  it('sections without a header, summary-only sections, blank and non-numeric values', () => {
    const r = R({
      Rows: {
        Row: [
          { type: 'Section', Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Loose line', id: '7' }, { value: '10.50' }] }] }, Summary: { ColData: [{ value: 'Sub' }, { value: '10.50' }] } },
          { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '' }] } },
          { type: 'Data', ColData: [{ value: 'Odd | name' }, { value: 'n/a' }] },
        ],
      },
    });
    const t = toTable(r);
    expect(t.rows.map((x) => [x.id, x.parentId, x.depth, x.kind])).toEqual([['1.1', '', 0, 'data'], ['1', '', 0, 'summary'], ['2', '', 0, 'summary'], ['3', '', 0, 'data']]);
    const w = toWidget(prepare('ProfitAndLoss', r, o)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(w.reportData.rows[1].cells[1]).toMatchObject({ value: 10.5, localizedValue: '$10.50' });
    expect(w.reportData.rows[3].cells[1]).toMatchObject({ value: null, localizedValue: null });
    expect(w.summary.netIncome).toBeNull();
    expect(toText(prepare('ProfitAndLoss', r, o))).toContain('Odd | name');
    expect(toText(prepare('BalanceSheet', r, o))).toContain('Odd \\| name');
  });
  it('uses the cash method and a missing currency default', () => {
    const r = R({ Header: { Option: [{ Name: 'AccountingMethod', Value: 'Cash' }], EndPeriod: '2026-01-31' } });
    expect(toWidget(prepare('BalanceSheet', r, o))).toMatchObject({ accountingMethod: 'cash', asOf: '2026-01-31' });
    expect(toText(prepare('BalanceSheet', r, o))).toContain('Cash basis');
  });
});

describe('client-side filters', () => {
  const ar = (f: Parameters<typeof agingSummaryFilter>[0]) => prepare('AgedReceivables', fx('ar_aging_summary'), { ...o, transform: agingSummaryFilter(f) });
  const names = (p: ReturnType<typeof ar>) => p.table.rows.filter((r) => r.kind === 'data').map((r) => r.cells[0]);
  const base = { exactName: true };

  it('top_n keeps the biggest balances and recomputes the totals', () => {
    const p = ar({ ...base, topN: 2 });
    expect(names(p)).toEqual(['Maple Leaf Logistics Inc.', 'Acme Corporation']);
    expect(p.summary.data).toMatchObject({ totalReceivables: 16950, customerCount: 2 });
  });
  it('min_days_overdue works on bucket thresholds', () => {
    expect(names(ar({ ...base, minDaysOverdue: 91 }))).toEqual(['Prairie Analytics Ltd.']);
    expect(names(ar({ ...base, minDaysOverdue: 31 }))).toEqual(['Maple Leaf Logistics Inc.', 'Northern Lights Studio Inc.', 'Prairie Analytics Ltd.']);
    expect(names(ar({ ...base, minDaysOverdue: 1 }))).toHaveLength(4);
    expect(names(ar({ ...base, minDaysOverdue: 0 }))).toEqual(['Acme Corporation', 'Maple Leaf Logistics Inc.', 'Harbourfront Dental Group']);
  });
  it('min_overdue_amount keeps customers whose overdue total reaches it', () => {
    expect(names(ar({ ...base, minOverdueAmount: 2500 }))).toEqual(['Maple Leaf Logistics Inc.', 'Prairie Analytics Ltd.']);
  });
  it('customer_name is a case-insensitive exact match; vendor_name is a partial one', () => {
    expect(names(ar({ ...base, name: 'acme corporation' }))).toEqual(['Acme Corporation']);
    expect(names(ar({ ...base, name: 'acme' }))).toEqual([]);
    const ap = prepare('AgedPayables', fx('ap_aging_summary'), { ...o, transform: agingSummaryFilter({ name: 'cloud', exactName: false }) });
    expect(names(ap)).toEqual(['Cloudcore Hosting Inc.']);
  });
  it('only one of min_days_overdue, min_overdue_amount and top_n at a time, as in the built-in', () => {
    for (const f of [{ minDaysOverdue: 1, topN: 1 }, { minOverdueAmount: 1, topN: 1 }, { minDaysOverdue: 1, minOverdueAmount: 5 }]) {
      expect(() => agingSummaryFilter({ ...base, ...f })).toThrow(GuardrailError);
    }
    expect(() => agingSummaryFilter({ ...base, name: 'x', topN: 1 })).not.toThrow();
    expect(agingSummaryFilter({ ...base })).toBeUndefined();
  });
  it('detail filters drop empty sections and recompute section and grand totals', () => {
    const d = (f: Partial<Parameters<typeof agingDetailFilter>[0]>) => prepare('AgedPayableDetail', fx('ap_aging_detail'), { ...o, transform: agingDetailFilter({ today: '2026-10-16', ...f }) });
    const overdue = d({ dueBefore: '2026-10-15' });
    expect(overdue.table.rows.filter((r) => r.kind === 'data').map((r) => r.cells[2])).toEqual(['CC-7781', 'H-2201']);
    expect(overdue.summary.data).toMatchObject({ transactionCount: 2, totalOpenBalance: 2825 });
    expect(overdue.table.rows.filter((r) => r.kind === 'header').map((r) => r.cells[0])).toEqual(['1 - 30 days past due', '61 - 90 days past due']);
    // a future cutoff also drops bills already overdue
    expect(d({ dueBefore: '2026-11-01' }).table.rows.filter((r) => r.kind === 'data').map((r) => r.cells[2])).toEqual(['OCT-RENT', '55120']);
    expect(d({ vendorName: 'cloudcore', transactionType: 'BILL' }).summary.data).toMatchObject({ transactionCount: 2, totalOpenBalance: 2938 });
    const arD = prepare('AgedReceivableDetail', fx('ar_aging_detail'), { ...o, transform: agingDetailFilter({ customerName: 'Northern Lights Studio Inc.', transactionType: 'credit memo', today: '2026-10-16' }) });
    expect(arD.summary.data).toMatchObject({ transactionCount: 1, totalOpenBalance: -339 });
  });
  it('product filters: names, value filter, top, bottom and sort', () => {
    const p = (f: Parameters<typeof itemSalesFilter>[0]) => prepare('ItemSales', fx('item_sales'), { ...o, transform: itemSalesFilter(f) });
    const names2 = (x: ReturnType<typeof p>) => x.table.rows.filter((r) => r.kind === 'data').map((r) => r.cells[0]);
    expect(names2(p({ productNames: ['consult', 'widget'] }))).toEqual(['Consulting Services', 'Hardware Widget']);
    expect(names2(p({ topN: 2 }))).toEqual(['Consulting Services', 'Software Subscription']);
    expect(names2(p({ bottomN: 1 }))).toEqual(['Installation Fee']);
    expect(names2(p({ column: 'Qty', op: 'gte', threshold: 36 }))).toEqual(['Consulting Services', 'Software Subscription', 'Hardware Widget']);
    expect(names2(p({ sortBy: 'Qty' }))[0]).toBe('Consulting Services');
    expect(p({ topN: 2 }).summary.data).toMatchObject({ totalSales: 91464, productCount: 2 });
    expect(() => itemSalesFilter({ topN: 1, bottomN: 1 })).toThrow(GuardrailError);
    expect(() => itemSalesFilter({ column: 'Amount' })).toThrow(GuardrailError);
    expect(() => itemSalesFilter({ column: 'Amount', op: 'bogus', threshold: 1 })).toThrow(GuardrailError);
    expect(() => p({ column: 'Nope', op: 'gt', threshold: 1 })).toThrow(GuardrailError);
  });
});
