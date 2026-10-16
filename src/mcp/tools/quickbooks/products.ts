import { z } from 'zod';
import type { QbItem, QbItemType } from '@/core/contracts/quickbooks';
import { GuardrailError } from '@/core/errors';
import { prepare, toWidget } from '@/intuit/reports/render';
import type { QbReport } from '@/core/contracts/quickbooks';
import { FAN_OUT_NOTE, checked, companyField, companyName, perCompany, qbTool } from './common';
import { today } from './params';

const TYPES: Record<string, QbItemType> = { service: 'Service', inventory: 'Inventory', noninventory: 'NonInventory' };
const norm = (s: string | undefined | null) => (s ?? '').trim().toLowerCase();

const itemType = (s: string | null | undefined): QbItemType | undefined => {
  if (!s) return undefined;
  const t = TYPES[norm(s).replace(/[\s_-]/g, '')];
  if (!t) throw new GuardrailError('item_type', 'item_type must be "Service", "Inventory" or "NonInventory".');
  return t;
};

const COLUMNS = { 'sales price': (i: QbItem) => i.UnitPrice ?? 0, 'qty on hand': (i: QbItem) => i.QtyOnHand ?? 0 } as const;
const columnOf = (s: string | null | undefined, what: string) => {
  const c = COLUMNS[norm(s) as keyof typeof COLUMNS];
  if (!c) throw new GuardrailError('column', `${what} must be "Sales Price" or "Qty on Hand".`);
  return c;
};

/** The list as a one-table report, so it goes through the same converter as the Reports API output. */
function asReport(items: QbItem[], date: string): QbReport {
  return {
    Header: { ReportName: 'ItemList', Currency: 'CAD', EndPeriod: date },
    Columns: {
      Column: [
        { ColTitle: 'Name', ColType: 'String' },
        { ColTitle: 'Type', ColType: 'String' },
        { ColTitle: 'Description', ColType: 'String' },
        { ColTitle: 'Sales Price', ColType: 'Money' },
        { ColTitle: 'Qty on Hand', ColType: 'Numeric' },
      ],
    },
    Rows: {
      Row: items.map((i) => ({
        type: 'Data',
        ColData: [{ value: i.Name ?? '', id: i.Id }, { value: i.Type ?? '' }, { value: i.Description ?? '' }, { value: i.UnitPrice === undefined ? '' : String(i.UnitPrice) }, { value: i.QtyOnHand === undefined ? '' : String(i.QtyOnHand) }],
      })),
    },
  };
}

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

export const productServiceListTool = qbTool({
  name: 'qbo_accounting_get_product_service_list',
  description:
    'Product/Service List from QuickBooks: every active product and service with name, type, description, sales price and quantity on hand. No date range; a current snapshot. ' +
    'product_name: keep items whose name or description contains any of the strings. item_type: "Service", "Inventory" or "NonInventory". ' +
    'top_n / bottom_n (not both): the highest or lowest sales prices. sort_by: "Sales Price" or "Qty on Hand" (descending). ' +
    'value_filter_column ("Sales Price" or "Qty on Hand"), value_filter_op (gt, gte, lt, lte, eq) and value_filter_threshold must be given together. ' +
    'To find an item id for an invoice line use qbo_catalog_search_products instead. Returns JSON: reportTitle, reportData.rows, displayColumns, summary (itemCount, byType).' +
    FAN_OUT_NOTE,
  input: z.object({
    bottom_n: opt(z.number().int()),
    item_type: opt(z.string()),
    product_name: opt(z.array(z.string())),
    sort_by: opt(z.string()),
    top_n: opt(z.number().int()),
    value_filter_column: opt(z.string()),
    value_filter_op: opt(z.string()),
    value_filter_threshold: opt(z.number()),
    account: companyField,
  }),
  kind: 'read',
  async handler(input, ctx) {
    const name = 'qbo_accounting_get_product_service_list';
    const plan = await checked(ctx, name, input.account, () => {
      const given = [input.value_filter_column, input.value_filter_op, input.value_filter_threshold].filter((x) => x != null).length;
      if (given > 0 && given < 3) throw new GuardrailError('filters/value', 'value_filter_column, value_filter_op and value_filter_threshold must all be given together.');
      if (input.top_n != null && input.bottom_n != null) throw new GuardrailError('filters/top-bottom', 'top_n and bottom_n cannot be used together.');
      const op = norm(input.value_filter_op);
      if (given === 3 && !['gt', 'gte', 'lt', 'lte', 'eq'].includes(op)) throw new GuardrailError('filters/op', 'value_filter_op must be one of gt, gte, lt, lte or eq.');
      return {
        type: itemType(input.item_type),
        names: (input.product_name ?? []).map(norm).filter(Boolean),
        value: given === 3 ? { get: columnOf(input.value_filter_column, 'value_filter_column'), op, threshold: input.value_filter_threshold! } : undefined,
        sort: input.sort_by ? columnOf(input.sort_by, 'sort_by') : undefined,
      };
    });
    const cmp: Record<string, (a: number, b: number) => boolean> = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };
    const r = await perCompany(ctx, name, input.account, async (qb, a) => {
      let items = await qb.listItems(plan.type ? { type: plan.type } : undefined);
      if (plan.names.length) items = items.filter((i) => plan.names.some((n) => norm(i.Name).includes(n) || norm(i.Description).includes(n)));
      if (plan.value) items = items.filter((i) => cmp[plan.value!.op]!(plan.value!.get(i), plan.value!.threshold));
      const price = COLUMNS['sales price'];
      if (input.top_n != null) items = [...items].sort((x, y) => price(y) - price(x)).slice(0, Math.max(0, input.top_n));
      else if (input.bottom_n != null) items = [...items].sort((x, y) => price(x) - price(y)).slice(0, Math.max(0, input.bottom_n));
      else if (plan.sort) items = [...items].sort((x, y) => plan.sort!(y) - plan.sort!(x));
      else items = [...items].sort((x, y) => (x.Name ?? '').localeCompare(y.Name ?? ''));
      return { rendered: prepare('ItemList', asReport(items, today()), { company: companyName(a), requestedMethod: 'accrual' }) };
    });
    return { reports: r.items.map(({ rendered, account, accountEmail }) => ({ account, accountEmail, ...toWidget(rendered) })), accountErrors: r.accountErrors };
  },
});
