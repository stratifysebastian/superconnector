import { z } from 'zod';
import type { QbReportName, QbReportParams } from '@/core/contracts/quickbooks';
import { GuardrailError } from '@/core/errors';
import { agingDetailFilter, agingSummaryFilter, itemSalesFilter } from '@/intuit/reports/filters';
import { prepare, toText, toWidget, type PrepareOptions } from '@/intuit/reports/render';
import type { AnyToolDef } from '@/mcp/registry';
import { FAN_OUT_NOTE, checked, companyField, companyName, perCompany, qbTool, textResult } from './common';
import { isoDate, periodParams, today } from './params';

interface Plan {
  report: QbReportName;
  params: QbReportParams;
  method: 'accrual' | 'cash';
  opts: Omit<PrepareOptions, 'company' | 'requestedMethod'>;
  /** Shown to the reader when part of a request could not be honoured. */
  notes?: string[];
}

const str = z.string().nullable().optional();
const int = z.number().int().nullable().optional();
const num = z.number().nullable().optional();

const MACRO_HELP =
  'date_range is a macro such as THIS_YEAR, LAST_YEAR, THIS_QUARTER, LAST_QUARTER, THIS_MONTH, LAST_MONTH, THIS_YEAR_TO_DATE, LAST_30_DAYS; start_date and end_date (YYYY-MM-DD) must be given together and replace it (one alone is ignored, with a note). "Quarter" and "year" mean calendar quarters and years, not fiscal ones; weeks run Monday to Sunday; LAST_12_MONTHS is the last 365 days; ALL is not supported.';
const TEXT_NOTE =
  ' PLAIN-TEXT variant: returns markdown (STATUS, title, Summary, Line Items) instead of JSON. Use it only when you will write the narrative yourself; for a direct question use the JSON tool of the same name without `_text`.';
const SHAPE_NOTE = ' Returns JSON: reportTitle, reportData.rows (cells, depth, metadata), displayColumns, summary, period or asOf, accountingMethod.';

/** One shared definition for a report; it produces the JSON tool and, when named, its `_text` twin. */
function defineReport<I extends z.ZodObject<z.ZodRawShape>>(cfg: {
  name: string;
  textName?: string;
  description: string;
  input: I;
  plan(i: z.infer<I>): Plan;
}): AnyToolDef[] {
  const run = async (name: string, input: z.infer<I>, ctx: Parameters<AnyToolDef['handler']>[1]) => {
    const plan = await checked(ctx, name, input.account as string | string[] | undefined, () => cfg.plan(input));
    return perCompany(ctx, name, input.account as string | string[] | undefined, async (qb, a) => {
      const rendered = prepare(plan.report, await qb.report(plan.report, plan.params), { ...plan.opts, company: companyName(a), requestedMethod: plan.method, ...(plan.notes ? { notes: plan.notes } : {}) });
      return { rendered };
    });
  };
  const json = qbTool({
    name: cfg.name,
    description: cfg.description + SHAPE_NOTE + FAN_OUT_NOTE,
    input: cfg.input,
    kind: 'read',
    async handler(input, ctx) {
      const r = await run(cfg.name, input, ctx);
      return { reports: r.items.map(({ rendered, account, accountEmail }) => ({ account, accountEmail, ...toWidget(rendered) })), accountErrors: r.accountErrors };
    },
  });
  if (!cfg.textName) return [json];
  const textName = cfg.textName;
  const text = qbTool({
    name: textName,
    description: cfg.description + TEXT_NOTE + FAN_OUT_NOTE,
    input: cfg.input,
    kind: 'read',
    async handler(input, ctx) {
      const r = await run(textName, input, ctx);
      return textResult(r.items.map((i) => ({ account: i.account, text: toText(i.rendered) })), r.accountErrors);
    },
  });
  return [json, text];
}

const asOf = (d: string | null | undefined, name = 'as_of_date'): QbReportParams => (d ? { report_date: isoDate(d, name) } : {});

// ---- statements

const bsInput = z.object({
  accounting_method: z.string().default('accrual'),
  date_range: str,
  end_date: str,
  split_by: str,
  start_date: str,
  account: companyField,
});
const balanceSheet = defineReport({
  name: 'qbo_accounting_get_balance_sheet',
  textName: 'qbo_accounting_get_balance_sheet_text',
  description:
    'Balance Sheet from QuickBooks: assets, liabilities and equity at a point in time (the END of the period). ' +
    `${MACRO_HELP} For an "as of <date>" question pass the same date as start_date and end_date. Default THIS_MONTH (THIS_YEAR when split_by is set). ` +
    'accounting_method is "accrual" (default) or "cash". split_by (MONTH, QUARTER, YEAR, WEEK, DAY) returns one as-of column per period for trends.',
  input: bsInput,
  plan(i) {
    const p = periodParams(i, { macro: 'THIS_MONTH', splitMacro: 'THIS_YEAR' });
    return { report: 'BalanceSheet', params: p.params, method: p.method, opts: { splitBy: p.split }, ...(p.notes.length ? { notes: p.notes } : {}) };
  },
});

const periodInput = z.object({
  periodEnd: z.string().nullable().optional().describe('End date for reporting period (YYYY-MM-DD, optional)'),
  periodStart: z.string().nullable().optional().describe('Start date for reporting period (YYYY-MM-DD, optional)'),
  account: companyField,
});
/** P&L and cash flow: periodStart and periodEnd together, else year to date; always with monthly columns. */
const periodPlan = (report: QbReportName) => (i: z.infer<typeof periodInput>): Plan => {
  const p = periodParams(
    { ...(i.periodStart && i.periodEnd ? { start_date: i.periodStart, end_date: i.periodEnd } : {}), split_by: 'MONTH', accounting_method: 'accrual' },
    { macro: 'THIS_YEAR_TO_DATE' },
  );
  const lone = i.periodStart || i.periodEnd ? [`Only ${i.periodStart ? 'periodStart' : 'periodEnd'} was given, so it was ignored; both are needed. The calendar year to date is shown.`] : [];
  return { report, params: p.params, method: p.method, opts: { splitBy: 'MONTH' }, ...(lone.length ? { notes: lone } : {}) };
};
const profitLoss = defineReport({
  name: 'profit_loss_quickbooks_account',
  textName: 'profit_loss_quickbooks_account_text',
  description:
    'Profit and loss report from QuickBooks: income, cost of goods sold, expenses, net profit and margins, with a monthly breakdown. ' +
    'periodStart and periodEnd (YYYY-MM-DD) must be given together; without them the calendar year to date is used. Accrual basis.',
  input: periodInput,
  plan: periodPlan('ProfitAndLoss'),
});
const cashFlow = defineReport({
  name: 'cash_flow_quickbooks_account',
  textName: 'cash_flow_quickbooks_account_text',
  description:
    'Cash flow report from QuickBooks: operating, investing and financing activities, net cash increase and cash at the end of the period, with a monthly breakdown. ' +
    'periodStart and periodEnd (YYYY-MM-DD) must be given together; without them the calendar year to date is used. Accrual basis.',
  input: periodInput,
  plan: periodPlan('CashFlow'),
});

// ---- aging

const agingSummaryFields = {
  as_of_date: str,
  min_days_overdue: int,
  min_overdue_amount: num,
  top_n: int,
};
const FILTER_NOTE =
  ' Only ONE of min_days_overdue (0, 1, 31, 61 or 91: 0 is current only, 1 all overdue), min_overdue_amount or top_n may be passed per call; answer anything else from the returned data.';

const arInput = z.object({ as_of_date: str, customer_name: str, min_days_overdue: int, min_overdue_amount: num, top_n: int, account: companyField });
const arPlan = (i: z.infer<typeof arInput>): Plan => ({
  report: 'AgedReceivables',
  params: asOf(i.as_of_date),
  method: 'accrual',
  opts: {
    transform: agingSummaryFilter({ name: i.customer_name, exactName: true, minDaysOverdue: i.min_days_overdue, minOverdueAmount: i.min_overdue_amount, topN: i.top_n }),
  },
});
const arSummary = defineReport({
  name: 'qbo_accounting_get_ar_aging_summary',
  textName: 'qbo_accounting_get_ar_aging_summary_text',
  description:
    'A/R Aging Summary from QuickBooks (accrual basis only): what each customer owes, by aging bucket (Current, 1-30, 31-60, 61-90, 91+). ' +
    'as_of_date (YYYY-MM-DD) defaults to today. customer_name filters to one customer (case-insensitive exact match). ' +
    'Also the default tool for general "what is overdue" questions.' +
    FILTER_NOTE,
  input: arInput,
  plan: arPlan,
});

const arDetail = defineReport({
  name: 'qbo_accounting_get_ar_aging_detail',
  description:
    'A/R Aging Detail from QuickBooks: every unpaid invoice (and credit memo, payment) with type, due date and amount, grouped by aging bucket. ' +
    'as_of_date (YYYY-MM-DD) defaults to today. customer_name filters to one customer (case-insensitive exact match). transaction_type filters by type, e.g. "invoice" or "credit memo" (case-insensitive).',
  input: z.object({ as_of_date: str, customer_name: str, transaction_type: str, account: companyField }),
  plan: (i) => ({
    report: 'AgedReceivableDetail',
    params: asOf(i.as_of_date),
    method: 'accrual',
    opts: { transform: agingDetailFilter({ customerName: i.customer_name, transactionType: i.transaction_type, today: today() }) },
  }),
});

const apSummary = defineReport({
  name: 'qbo_accounting_get_ap_aging_summary',
  description:
    'A/P Aging Summary from QuickBooks: what the company owes each vendor, by aging bucket. as_of_date (YYYY-MM-DD) defaults to today. ' +
    'vendor_name keeps vendors whose name contains the text (case-insensitive).' +
    FILTER_NOTE,
  input: z.object({ ...agingSummaryFields, vendor_name: str, account: companyField }),
  plan: (i) => ({
    report: 'AgedPayables',
    params: asOf(i.as_of_date),
    method: 'accrual',
    opts: { transform: agingSummaryFilter({ name: i.vendor_name, exactName: false, minDaysOverdue: i.min_days_overdue, minOverdueAmount: i.min_overdue_amount, topN: i.top_n }) },
  }),
});

const apDetail = defineReport({
  name: 'qbo_accounting_get_ap_aging_detail',
  description:
    'A/P Aging Detail from QuickBooks: every unpaid bill with type, due date and amount, grouped by aging bucket and vendor. as_of_date (YYYY-MM-DD) defaults to today. ' +
    'vendor_name keeps vendors whose name contains the text (case-insensitive). transaction_type: "bill" for bills only. ' +
    'due_before (YYYY-MM-DD, inclusive) keeps bills due on or before that date; a future date also drops bills already overdue, so pass yesterday for an overdue view.',
  input: z.object({ as_of_date: str, due_before: str, transaction_type: str, vendor_name: str, account: companyField }),
  plan: (i) => ({
    report: 'AgedPayableDetail',
    params: asOf(i.as_of_date),
    method: 'accrual',
    opts: { transform: agingDetailFilter({ vendorName: i.vendor_name, transactionType: i.transaction_type, dueBefore: i.due_before ? isoDate(i.due_before, 'due_before') : null, today: today() }) },
  }),
});

// ---- sales

const salesPlanBase = (i: Parameters<typeof periodParams>[0]) => periodParams(i, { macro: 'THIS_YEAR' });

const customerSales = defineReport({
  name: 'qbo_accounting_get_sales_by_customer_summary',
  textName: 'qbo_accounting_get_sales_by_customer_summary_text',
  description:
    'Sales by Customer Summary from QuickBooks: total sales per customer for a period. ' +
    `${MACRO_HELP} Default THIS_YEAR. accounting_method "accrual" (default) or "cash". split_by MONTH, QUARTER or YEAR adds a column per period. ` +
    'top_n (default 10) with ranking "top" (default) or "bottom" sets the ranking list in the summary. compare_to is not supported yet and is ignored with a note.',
  input: z.object({
    accounting_method: z.string().default('accrual'),
    compare_to: str,
    date_range: str,
    end_date: str,
    ranking: z.string().default('top'),
    split_by: str,
    start_date: str,
    top_n: z.number().int().default(10),
    account: companyField,
  }),
  plan(i) {
    const p = salesPlanBase(i);
    const ranking = i.ranking.trim().toLowerCase();
    if (ranking !== 'top' && ranking !== 'bottom') throw new GuardrailError('ranking', 'ranking must be "top" or "bottom".');
    return {
      report: 'CustomerSales',
      params: p.params,
      method: p.method,
      opts: { topN: Math.max(1, i.top_n), ranking, splitBy: p.split },
      ...(i.compare_to || p.notes.length ? { notes: [...p.notes, ...(i.compare_to ? ['compare_to is not supported by this server yet; this is the current period only.'] : [])] } : {}),
    };
  },
});

const productSales = defineReport({
  name: 'qbo_accounting_get_sales_by_product_summary',
  textName: 'qbo_accounting_get_sales_by_product_summary_text',
  description:
    'Sales by Product/Service Summary from QuickBooks: sales per product or service with quantity, average price and share of sales (revenue, not profit). ' +
    `${MACRO_HELP} Default THIS_YEAR. accounting_method "accrual" (default) or "cash". split_by MONTH, QUARTER, YEAR, WEEK or DAY adds a column per period. ` +
    'product_name: keep products whose name contains any of the strings. top_n / bottom_n (not both) rank by amount. sort_by: "Amount", "Qty", "% of Sales" or "Avg Price". ' +
    'value_filter_column ("Amount", "Qty", "% of Sales", "Avg Price"), value_filter_op (gt, gte, lt, lte, eq) and value_filter_threshold must be given together.',
  input: z.object({
    accounting_method: z.string().default('accrual'),
    bottom_n: int,
    date_range: str,
    end_date: str,
    product_name: z.array(z.string()).nullable().optional(),
    sort_by: str,
    split_by: str,
    start_date: str,
    top_n: int,
    value_filter_column: str,
    value_filter_op: str,
    value_filter_threshold: num,
    account: companyField,
  }),
  plan(i) {
    const p = salesPlanBase(i);
    return {
      report: 'ItemSales',
      params: p.params,
      method: p.method,
      ...(p.notes.length ? { notes: p.notes } : {}),
      opts: {
        splitBy: p.split,
        transform: itemSalesFilter({ productNames: i.product_name, topN: i.top_n, bottomN: i.bottom_n, sortBy: i.sort_by, column: i.value_filter_column, op: i.value_filter_op, threshold: i.value_filter_threshold }),
      },
    };
  },
});

export const reportTools = (): AnyToolDef[] => [
  ...balanceSheet, ...profitLoss, ...cashFlow, ...arSummary, ...arDetail, ...apSummary, ...apDetail, ...customerSales, ...productSales,
];
