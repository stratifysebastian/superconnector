import type { QuickBooksAdapterContext } from '@/core/contracts/adapter';
import type { QbCompanyInfo, QbCustomer, QbItem, QbReport, QbReportName, QuickBooksAdapter } from '@/core/contracts/quickbooks';
import { loadFixture } from '@/google/mock/fixtures';
import { customerBody, itemBody } from '../quickbooks';

const REPORT_FIXTURES: Record<QbReportName, string> = {
  BalanceSheet: 'balance_sheet',
  ProfitAndLoss: 'profit_loss',
  CashFlow: 'cash_flow',
  AgedReceivables: 'ar_aging_summary',
  AgedReceivableDetail: 'ar_aging_detail',
  AgedPayables: 'ap_aging_summary',
  AgedPayableDetail: 'ap_aging_detail',
  CustomerSales: 'customer_sales',
  ItemSales: 'item_sales',
};

const has = (hay: string | undefined, needle: string) => (hay ?? '').toLowerCase().includes(needle.trim().toLowerCase());
let seq = 0;

/**
 * Reads fixtures/quickbooks/<label>/*.json. Never touches the network.
 * Mock limits: reports ignore the requested dates and column split (only the accounting method and the period in the
 * Header follow the request), and created records are echoed back, not stored.
 */
export function createMockQuickBooksAdapter(ctx: QuickBooksAdapterContext): QuickBooksAdapter {
  const load = <T>(name: string) => loadFixture<T>('quickbooks', ctx.account.label, name);
  return {
    async companyInfo() {
      return load<QbCompanyInfo>('companyinfo');
    },
    async report(name, p) {
      const base = load<QbReport>(REPORT_FIXTURES[name]);
      const header = { ...base.Header };
      if (p.accounting_method) {
        header.ReportBasis = p.accounting_method;
        header.Option = (header.Option ?? []).map((o) => (o.Name === 'AccountingMethod' ? { ...o, Value: p.accounting_method } : o));
      }
      const start = p.start_date ?? p.report_date;
      const end = p.end_date ?? p.report_date;
      if (start) header.StartPeriod = start;
      if (end) header.EndPeriod = end;
      return { ...base, Header: header };
    },
    async listItems(f) {
      return load<QbItem[]>('items').filter((i) => i.Active !== false && (!f?.type || i.Type === f.type));
    },
    async findItems(term) {
      return load<QbItem[]>('items').filter((i) => i.Active !== false && has(i.Name, term)).slice(0, 20);
    },
    async findCustomers({ name, email }) {
      const all = load<QbCustomer[]>('customers').filter((c) => c.Active !== false);
      return all.filter((c) => (name && has(c.DisplayName, name)) || (email && c.PrimaryEmailAddr?.Address?.toLowerCase() === email.toLowerCase()));
    },
    async createItem(input) {
      seq++;
      return { ...itemBody(input, { income: 'mock-income', asset: 'mock-asset', expense: 'mock-cogs' }), Id: `mock-item-${seq}`, Active: true, SyncToken: '0' } as QbItem;
    },
    async createCustomer(input) {
      seq++;
      return { ...customerBody(input), Id: `mock-customer-${seq}`, Active: true, SyncToken: '0' } as QbCustomer;
    },
  };
}
