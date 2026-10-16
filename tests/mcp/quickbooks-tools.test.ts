import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/core/contracts/account';
import type { QbCompanyInfo, QbItem, QuickBooksAdapter } from '@/core/contracts/quickbooks';
import type { LogEvent, ToolContext } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { AccountSelectionError, GuardrailError, ProviderError } from '@/core/errors';
import { scopeToolContext } from '@/core/scope';
import { createIntuitHttp } from '@/intuit/http';
import { createMockQuickBooksAdapter } from '@/intuit/mock/quickbooks';
import { createLiveQuickBooksAdapter } from '@/intuit/quickbooks';
import { buildServer, getToolDefs } from '@/mcp/registry';
import { quickbooksTools } from '@/mcp/tools/quickbooks';
import { ENABLED_TOOL_NAMES } from '../contract/enabled';
import { EXCLUDED_TOOL_NAMES } from '../contract/excluded';

const acct = (label: string, priority: number, provider: Account['provider'] = 'intuit'): Account => ({
  id: `id-${label}`, provider, email: `books@${label}.test`, label, orgClientId: 'org', priority, connectedAt: '2026-01-01T00:00:00Z', status: 'active', grantedScopes: [],
  ...(provider === 'intuit' ? { realmId: `realm-${label}`, companyName: `Company ${label.toUpperCase()}` } : {}),
});
let accounts: Account[];
let audit: { tool: string; account: string; targetId?: string; outcome: string; detail?: string }[];
let logs: LogEvent[];
let adapterFor: (a: Account) => QuickBooksAdapter;
let ctx: ToolContext;

/** Both companies serve the stratify-ca fixtures; only the tags differ. */
const mockFor = (a: Account) => createMockQuickBooksAdapter({ account: { ...a, label: 'stratify-ca' }, http: undefined as never, signal: new AbortController().signal });

beforeEach(() => {
  accounts = [acct('stratify-ca', 0), acct('second-ca', 1), acct('seb-gmail', 2, 'google')];
  audit = [];
  logs = [];
  adapterFor = mockFor;
  ctx = {
    store: { accounts: { list: async () => accounts }, audit: { write: async (e: (typeof audit)[number]) => void audit.push(e) } },
    fanout: createFanOutEngine({ listAccounts: async () => accounts, cursorSecret: 's'.repeat(32), reconnectUrl: '/connect' }),
    adapters: { quickbooks: (c: { account: Account }) => adapterFor(c.account) },
    quickbooksContext: (account: Account) => ({ account }),
    log: { info: (e: LogEvent) => void logs.push(e), warn: (e: LogEvent) => void logs.push(e), error: (e: LogEvent) => void logs.push(e) },
  } as unknown as ToolContext;
});

const tool = (name: string) => getToolDefs('http://x').find((d) => d.name === name)!;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const def = tool(name);
  return (await def.handler(def.input.parse(args) as never, scopeToolContext(ctx, 'intuit'))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const one = { account: 'stratify-ca' };
const QB_NAMES = quickbooksTools().map((t) => t.name);

describe('registry', () => {
  it('registers the 21 QuickBooks tools, all on the intuit provider, and none of the excluded names', () => {
    expect(QB_NAMES).toHaveLength(21);
    const defs = getToolDefs('http://x');
    expect(defs).toHaveLength(60);
    expect(defs.filter((d) => d.provider === 'intuit').map((d) => d.name).sort()).toEqual([...QB_NAMES].sort());
    expect(ENABLED_TOOL_NAMES).toEqual(expect.arrayContaining(QB_NAMES));
    expect(defs.map((d) => d.name).filter((n) => EXCLUDED_TOOL_NAMES.includes(n))).toEqual([]);
    expect(QB_NAMES.filter((n) => /payroll|lending|delete|send|invoice/.test(n))).toEqual([]);
  });
  it('every tool has the optional account input, and only the creates are writes', () => {
    for (const d of quickbooksTools()) {
      expect(Object.keys(d.input.shape)).toContain('account');
      expect(d.kind).toBe(d.name.includes('create') ? 'write' : d.name.includes('search') ? 'lookup' : 'read');
    }
  });
  it('inputs match the built-in connector\'s names', () => {
    const keys = (n: string) => Object.keys(tool(n).input.shape).filter((k) => k !== 'account').sort();
    expect(keys('qbo_accounting_get_balance_sheet')).toEqual(['accounting_method', 'date_range', 'end_date', 'split_by', 'start_date']);
    expect(keys('profit_loss_quickbooks_account_text')).toEqual(['periodEnd', 'periodStart']);
    expect(keys('qbo_accounting_get_ar_aging_summary')).toEqual(['as_of_date', 'customer_name', 'min_days_overdue', 'min_overdue_amount', 'top_n']);
    expect(keys('qbo_accounting_get_ap_aging_detail')).toEqual(['as_of_date', 'due_before', 'transaction_type', 'vendor_name']);
    expect(keys('qbo_accounting_get_sales_by_customer_summary')).toEqual(['accounting_method', 'compare_to', 'date_range', 'end_date', 'ranking', 'split_by', 'start_date', 'top_n']);
    expect(keys('qbo_catalog_create_product')).toEqual(['input_data']);
    expect(keys('qbo_contact_search_customer')).toEqual(['customer_email', 'customer_name']);
  });
  it('a QuickBooks tool cannot be pointed at a Google account', async () => {
    await expect(call('company_info', { account: 'seb-gmail' })).rejects.toBeInstanceOf(AccountSelectionError);
  });
});

describe('company_info', () => {
  it('is plain text, exactly two lines per company', async () => {
    const r = await call('company_info', one);
    expect(r.mcpText).toBe('Company Name: Stratify Software Canada Inc. (mock)\nIndustry: Software Publishers');
    expect(r.accountErrors).toEqual([]);
  });
  it('fans out: one labelled block per company, never merged', async () => {
    const r = await call('company_info');
    expect(r.mcpText).toBe(
      'stratify-ca:\nCompany Name: Stratify Software Canada Inc. (mock)\nIndustry: Software Publishers\n\nsecond-ca:\nCompany Name: Stratify Software Canada Inc. (mock)\nIndustry: Software Publishers',
    );
  });
  it('Industry is Unknown when none is set, and a failing company is named as not included', async () => {
    adapterFor = (a) =>
      a.label === 'second-ca'
        ? ({ companyInfo: async () => { throw new ProviderError('timeout', 'slow'); } } as unknown as QuickBooksAdapter)
        : ({ companyInfo: async (): Promise<QbCompanyInfo> => ({ CompanyName: 'Bare Co' }) } as unknown as QuickBooksAdapter);
    const r = await call('company_info');
    expect(r.mcpText).toBe('Company Name: Bare Co\nIndustry: Unknown\n\nNot included: SECOND-CA account: slow');
    expect(r.accountErrors).toHaveLength(1);
  });
});

const JSON_REPORTS: [string, string][] = [
  ['qbo_accounting_get_balance_sheet', 'Balance Sheet'], ['profit_loss_quickbooks_account', 'Profit and Loss'], ['cash_flow_quickbooks_account', 'Statement of Cash Flows'],
  ['qbo_accounting_get_ar_aging_summary', 'A/R Aging Summary'], ['qbo_accounting_get_ar_aging_detail', 'A/R Aging Detail'], ['qbo_accounting_get_ap_aging_summary', 'A/P Aging Summary'],
  ['qbo_accounting_get_ap_aging_detail', 'A/P Aging Detail'], ['qbo_accounting_get_sales_by_customer_summary', 'Sales by Customer Summary'],
  ['qbo_accounting_get_sales_by_product_summary', 'Sales by Product/Service Summary'], ['qbo_accounting_get_product_service_list', 'Product/Service List'],
];
describe('reports in mock mode', () => {
  it.each(JSON_REPORTS)('%s returns the widget JSON for the one company', async (name, title) => {
    const r = await call(name, one);
    expect(r.accountErrors).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toMatchObject({ account: 'stratify-ca', accountEmail: 'books@stratify-ca.test', reportTitle: title, accountingMethod: 'accrual' });
    expect(r.reports[0].reportData.rows.length).toBeGreaterThan(0);
  });
  it.each(JSON_REPORTS.map(([n]) => n).filter((n) => QB_NAMES.includes(`${n}_text`)))('%s_text returns markdown', async (name) => {
    const r = await call(`${name}_text`, one);
    expect(r.mcpText).toMatch(/^STATUS: success\n\n## /);
    expect(r.mcpText).toContain('### Line Items');
    expect(r.accountErrors).toEqual([]);
  });
  it('has exactly the _text variants the built-in has', () => {
    expect(QB_NAMES.filter((n) => n.endsWith('_text')).sort()).toEqual([
      'cash_flow_quickbooks_account_text', 'profit_loss_quickbooks_account_text', 'qbo_accounting_get_ar_aging_summary_text', 'qbo_accounting_get_balance_sheet_text',
      'qbo_accounting_get_sales_by_customer_summary_text', 'qbo_accounting_get_sales_by_product_summary_text',
    ]);
  });
  it('fans out across companies: one tagged report each, totals never added', async () => {
    const r = await call('qbo_accounting_get_ar_aging_summary');
    expect(r.reports.map((x: { account: string }) => x.account)).toEqual(['stratify-ca', 'second-ca']);
    expect(r.reports.map((x: any) => x.summary.totalReceivables)).toEqual([22487, 22487]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(r)).not.toContain('44974');
    const t = await call('qbo_accounting_get_balance_sheet_text');
    expect(t.mcpText.match(/STATUS: success/g)).toHaveLength(2);
    expect(t.mcpText).toMatch(/^stratify-ca:\nSTATUS: success[\s\S]*\n\nsecond-ca:\nSTATUS: success/);
    expect((await call('qbo_accounting_get_ar_aging_summary', { account: 'second-ca' })).reports).toHaveLength(1);
  });
  it('a company that fails is reported, the others still return', async () => {
    adapterFor = (a) => (a.label === 'second-ca' ? ({ report: async () => { throw new ProviderError('rate_limited', 'x'); } } as unknown as QuickBooksAdapter) : mockFor(a));
    const r = await call('qbo_accounting_get_balance_sheet');
    expect(r.reports).toHaveLength(1);
    expect(r.accountErrors).toMatchObject([{ account: 'second-ca', kind: 'rate_limited' }]);
  });
  it('client-side filters run after fetching, with the single-filter rule', async () => {
    const top = await call('qbo_accounting_get_ar_aging_summary', { ...one, top_n: 2 });
    expect(top.reports[0].summary).toMatchObject({ customerCount: 2, totalReceivables: 16950 });
    expect((await call('qbo_accounting_get_ar_aging_summary', { ...one, min_days_overdue: 91 })).reports[0].summary.customerCount).toBe(1);
    expect((await call('qbo_accounting_get_ar_aging_summary', { ...one, customer_name: 'Acme Corporation' })).reports[0].summary.customerCount).toBe(1);
    await expect(call('qbo_accounting_get_ar_aging_summary', { ...one, top_n: 2, min_days_overdue: 1 })).rejects.toThrow(/only one of/i);
    await expect(call('qbo_accounting_get_ap_aging_summary', { ...one, top_n: 2, min_overdue_amount: 5 })).rejects.toBeInstanceOf(GuardrailError);
    expect(audit.filter((a) => a.outcome === 'rejected').map((a) => a.tool)).toEqual(['qbo_accounting_get_ar_aging_summary', 'qbo_accounting_get_ap_aging_summary']);
    const bills = await call('qbo_accounting_get_ap_aging_detail', { ...one, transaction_type: 'bill', vendor_name: 'bell' });
    expect(bills.reports[0].summary).toMatchObject({ transactionCount: 1, totalOpenBalance: 242.5 });
  });
  it('product list filters and orders', async () => {
    const names = (r: any) => r.reports[0].reportData.rows.map((x: any) => x.cells[0].value); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(names(await call('qbo_accounting_get_product_service_list', one))).not.toContain('Legacy Plan');
    expect(names(await call('qbo_accounting_get_product_service_list', { ...one, item_type: 'inventory' }))).toEqual(['Hardware Widget']);
    expect(names(await call('qbo_accounting_get_product_service_list', { ...one, top_n: 2 }))).toEqual(['Training Workshop', 'Support Retainer']);
    expect(names(await call('qbo_accounting_get_product_service_list', { ...one, product_name: ['training'] }))).toEqual(['Training Session', 'Training Workshop']);
    expect(names(await call('qbo_accounting_get_product_service_list', { ...one, value_filter_column: 'Qty on Hand', value_filter_op: 'gt', value_filter_threshold: 10 }))).toEqual(['Hardware Widget']);
    await expect(call('qbo_accounting_get_product_service_list', { ...one, top_n: 1, bottom_n: 1 })).rejects.toBeInstanceOf(GuardrailError);
    await expect(call('qbo_accounting_get_product_service_list', { ...one, value_filter_column: 'Sales Price' })).rejects.toBeInstanceOf(GuardrailError);
    await expect(call('qbo_accounting_get_product_service_list', { ...one, item_type: 'gadget' })).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe('report parameters sent to the Reports API', () => {
  let report: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    report = vi.fn(async (...a: Parameters<QuickBooksAdapter['report']>) => mockFor(accounts[0]!).report(...a));
    adapterFor = () => ({ report }) as unknown as QuickBooksAdapter;
  });
  const sent = () => report.mock.calls.map((c) => c.slice(0, 2));

  it('balance sheet: macro default, as-of date, split trend, cash', async () => {
    await call('qbo_accounting_get_balance_sheet', one);
    await call('qbo_accounting_get_balance_sheet', { ...one, start_date: '2026-03-31', end_date: '2026-03-31', accounting_method: 'Cash' });
    await call('qbo_accounting_get_balance_sheet', { ...one, split_by: 'quarter' });
    await call('qbo_accounting_get_balance_sheet', { ...one, date_range: 'LAST_QUARTER', start_date: '2026-01-01' });
    expect(sent()).toEqual([
      ['BalanceSheet', { date_macro: 'This Month', accounting_method: 'Accrual' }],
      ['BalanceSheet', { start_date: '2026-03-31', end_date: '2026-03-31', accounting_method: 'Cash' }],
      ['BalanceSheet', { date_macro: 'This Year', accounting_method: 'Accrual', summarize_column_by: 'Quarter' }],
      ['BalanceSheet', { date_macro: 'Last Fiscal Quarter', accounting_method: 'Accrual' }], // one date alone is ignored
    ]);
  });
  it('p&l and cash flow: both dates or year to date, always monthly', async () => {
    await call('profit_loss_quickbooks_account', { ...one, periodStart: '2026-01-01', periodEnd: '2026-06-30' });
    await call('cash_flow_quickbooks_account', one);
    await call('cash_flow_quickbooks_account_text', { ...one, periodStart: '2026-01-01' });
    expect(sent()).toEqual([
      ['ProfitAndLoss', { start_date: '2026-01-01', end_date: '2026-06-30', accounting_method: 'Accrual', summarize_column_by: 'Month' }],
      ['CashFlow', { date_macro: 'This Year-to-date', accounting_method: 'Accrual', summarize_column_by: 'Month' }],
      ['CashFlow', { date_macro: 'This Year-to-date', accounting_method: 'Accrual', summarize_column_by: 'Month' }],
    ]);
  });
  it('aging: only report_date goes out; names and amounts are filtered here', async () => {
    await call('qbo_accounting_get_ar_aging_summary', { ...one, as_of_date: '2026-09-30', customer_name: 'Acme Corporation' });
    await call('qbo_accounting_get_ar_aging_detail', { ...one, customer_name: 'x', transaction_type: 'invoice' });
    await call('qbo_accounting_get_ap_aging_summary', { ...one, vendor_name: 'x' });
    await call('qbo_accounting_get_ap_aging_detail', { ...one, due_before: '2026-12-01', vendor_name: 'y' });
    expect(sent()).toEqual([
      ['AgedReceivables', { report_date: '2026-09-30' }], ['AgedReceivableDetail', {}], ['AgedPayables', {}], ['AgedPayableDetail', {}],
    ]);
  });
  it('sales reports: macros, split and defaults', async () => {
    await call('qbo_accounting_get_sales_by_customer_summary_text', { ...one, date_range: 'LAST_YEAR', split_by: 'MONTH', accounting_method: 'cash' });
    await call('qbo_accounting_get_sales_by_product_summary', { ...one, start_date: '2026-02-01', end_date: '2026-02-28' });
    await call('qbo_accounting_get_sales_by_product_summary', one);
    expect(sent()).toEqual([
      ['CustomerSales', { date_macro: 'Last Year', accounting_method: 'Cash', summarize_column_by: 'Month' }],
      ['ItemSales', { start_date: '2026-02-01', end_date: '2026-02-28', accounting_method: 'Accrual' }],
      ['ItemSales', { date_macro: 'This Year', accounting_method: 'Accrual' }],
    ]);
  });
  it('compare_to is not supported and says so', async () => {
    const r = await call('qbo_accounting_get_sales_by_customer_summary', { ...one, compare_to: 'PREVIOUS_YEAR' });
    expect(r.reports[0].notes[0]).toMatch(/compare_to is not supported/);
  });
  it.each([
    ['qbo_accounting_get_balance_sheet', { date_range: 'LAST_6_MONTHS' }],
    ['qbo_accounting_get_balance_sheet', { start_date: '2026-02-30', end_date: '2026-03-01' }],
    ['qbo_accounting_get_balance_sheet', { accounting_method: 'both' }],
    ['qbo_accounting_get_balance_sheet', { split_by: 'DECADE' }],
    ['profit_loss_quickbooks_account', { periodStart: 'yesterday', periodEnd: 'today' }],
    ['qbo_accounting_get_ar_aging_summary', { as_of_date: '10/16/2026' }],
    ['qbo_accounting_get_sales_by_customer_summary', { ranking: 'middle' }],
  ])('%s refuses %j before calling QuickBooks and audits the refusal', async (name, args) => {
    await expect(call(name, { ...one, ...args })).rejects.toBeInstanceOf(GuardrailError);
    expect(report).not.toHaveBeenCalled();
    expect(audit).toMatchObject([{ tool: name, account: 'stratify-ca', outcome: 'rejected' }]);
  });
});

describe('product and customer search', () => {
  const m = (r: any, i = 0) => r.companies[0].data.results[i]; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('finds an exact product with its id, price and tax fields', async () => {
    const r = await call('qbo_catalog_search_products', { ...one, descriptions: ['consulting services', 'Hardware Widget', 'Installation Fee', 'Space Elevator'] });
    expect(r.companies[0]).toMatchObject({ status: 'success', error: null, meta: { descriptions_count: 4, matched_count: 3 }, account: 'stratify-ca' });
    expect(m(r, 0)).toMatchObject({ found: true, requires_clarification: false, match_quality: 'exact', description_searched: 'consulting services' });
    expect(m(r, 0).best_match).toMatchObject({ id: '1', name: 'Consulting Services', unit_price: 175, taxable: null, sales_tax_code: 'HST ON', score: 1 });
    expect(m(r, 1).best_match).toMatchObject({ sku: 'HW-001', quantity_on_hand: 40, type: 'Inventory' });
    expect(m(r, 2).best_match.taxable).toBe(true);
    expect(m(r, 3)).toMatchObject({ found: false, matches: [], best_match: null, requires_clarification: false, match_quality: 'no_match' });
    expect(r.companies[0].data).toMatchObject({ success: true, requires_clarification: false });
    expect(r.companies[0].data.message).toMatch(/Found 3 of 4/);
  });
  it('asks for clarification when two products fit, and falls back to the longest word', async () => {
    const r = await call('qbo_catalog_search_products', { ...one, descriptions: ['Training', 'consulting hours'] });
    expect(m(r, 0)).toMatchObject({ found: true, requires_clarification: true });
    expect(m(r, 0).matches.map((x: { name: string }) => x.name).sort()).toEqual(['Training Session', 'Training Workshop']);
    expect(m(r, 1).best_match.name).toBe('Consulting Services');
    expect(m(r, 1).match_quality).not.toBe('exact');
    expect(r.companies[0].data.requires_clarification).toBe(true);
  });
  it('limits to 20 descriptions and asks each company separately', async () => {
    await expect(call('qbo_catalog_search_products', { descriptions: Array(21).fill('x') })).rejects.toThrow();
    const r = await call('qbo_catalog_search_products', { descriptions: ['Support Retainer'] });
    expect(r.companies.map((c: { account: string }) => c.account)).toEqual(['stratify-ca', 'second-ca']);
  });
  it('searches one query at a time and passes the raw text to the adapter, which escapes it', async () => {
    const findItems = vi.fn(async (): Promise<QbItem[]> => []);
    adapterFor = () => ({ findItems }) as unknown as QuickBooksAdapter;
    await call('qbo_catalog_search_products', { ...one, descriptions: ["it's a '; drop"] });
    expect(findItems.mock.calls[0]).toEqual(["it's a '; drop"]);
  });

  it('customers: name search is ranked; an email match is a full match', async () => {
    const acme = (await call('qbo_contact_search_customer', { ...one, customer_name: 'Acme' })).companies[0].data;
    expect(acme).toMatchObject({ found: true, requires_clarification: true, total_candidates: 2 });
    expect(acme.matches.map((x: { display_name: string }) => x.display_name).sort()).toEqual(['Acme Corporation', 'Acme Industries Ltd.']);
    const exact = (await call('qbo_contact_search_customer', { ...one, customer_name: 'maple leaf logistics inc.' })).companies[0].data;
    expect(exact).toMatchObject({ found: true, requires_clarification: false, match_quality: 'exact' });
    expect(exact.best_match).toMatchObject({ id: '3', display_name: 'Maple Leaf Logistics Inc.', email: 'billing@mapleleaf.example', score: 1 });
    const byMail = (await call('qbo_contact_search_customer', { ...one, customer_name: 'Someone else', customer_email: 'FINANCE@prairie.example' })).companies[0].data;
    expect(byMail.best_match).toMatchObject({ display_name: 'Prairie Analytics Ltd.', score: 1 });
    const none = (await call('qbo_contact_search_customer', { ...one, customer_name: 'Zzyzx' })).companies[0].data;
    expect(none).toMatchObject({ found: false, matches: [], best_match: null, match_quality: 'no_match', total_candidates: 0 });
  });
});

describe('creates', () => {
  it('create_product: needs exactly one company, audits ok with the id only, sends no tax fields unless asked', async () => {
    await expect(call('qbo_catalog_create_product', { input_data: { name: 'Gadget', unit_price: 10 } })).rejects.toBeInstanceOf(AccountSelectionError);
    expect(audit).toEqual([]);
    const r = await call('qbo_catalog_create_product', { ...one, input_data: { name: 'Gadget', unit_price: 10, description: 'A gadget', sku: 'G-1' } });
    expect(r).toMatchObject({ status: 'success', error: null, account: 'stratify-ca', data: { success: true, product: { name: 'Gadget', type: 'Service', unit_price: 10, taxable: null } } });
    expect(r.data.product.id).toMatch(/^mock-item-/);
    expect(audit).toEqual([{ tool: 'qbo_catalog_create_product', account: 'stratify-ca', targetId: r.data.product.id, outcome: 'ok' }]);
    expect(JSON.stringify(audit)).not.toContain('Gadget');
    expect((await call('qbo_catalog_create_product', { ...one, input_data: { name: 'Taxed', unit_price: 1, taxable: true } })).data.product.taxable).toBe(true);
  });
  it('create_product: types, inventory rules and dates', async () => {
    const inv = await call('qbo_catalog_create_product', { ...one, input_data: { name: 'Bolt', unit_price: 2, product_type: 'inventory', quantity_on_hand: 12, inventory_start_date: '2026-01-01' } });
    expect(inv.data.product).toMatchObject({ type: 'Inventory', quantity_on_hand: 12 });
    expect((await call('qbo_catalog_create_product', { ...one, input_data: { name: 'N', unit_price: 2, product_type: 'NON_INVENTORY' } })).data.product.type).toBe('NonInventory');
    for (const input_data of [
      { name: 'Bolt', unit_price: 2, product_type: 'INVENTORY' },
      { name: 'Bolt', unit_price: 2, product_type: 'INVENTORY', quantity_on_hand: 1, inventory_start_date: '2026-13-01' },
      { name: 'X', unit_price: 2, product_type: 'BUNDLE' },
    ]) {
      await expect(call('qbo_catalog_create_product', { ...one, input_data })).rejects.toBeInstanceOf(GuardrailError);
    }
    await expect(call('qbo_catalog_create_product', { ...one, input_data: { name: '', unit_price: 1 } })).rejects.toThrow();
    await expect(call('qbo_catalog_create_product', { ...one, input_data: { name: 'x'.repeat(101), unit_price: 1 } })).rejects.toThrow();
  });
  it('create_product: the only connected company is used when none is named', async () => {
    accounts = [acct('stratify-ca', 0), acct('seb-gmail', 2, 'google')];
    expect((await call('qbo_catalog_create_product', { input_data: { name: 'Solo', unit_price: 1 } })).account).toBe('stratify-ca');
  });
  it('create_customer: one company, audited with the id only', async () => {
    await expect(call('qbo_contact_create_customer', { input_data: { display_name: 'Zed Ltd.' } })).rejects.toBeInstanceOf(AccountSelectionError);
    const r = await call('qbo_contact_create_customer', {
      ...one,
      input_data: { display_name: 'Zed Ltd.', first_name: 'Zed', additional_params: { email: 'zed@zed.example', phone_number: '555-0100', billing_address: '1 King St, Toronto ON M5H 1A1' } },
    });
    expect(r).toMatchObject({ status: 'success', account: 'stratify-ca', data: { customer: { display_name: 'Zed Ltd.', email: 'zed@zed.example', phone: '555-0100' } } });
    expect(audit).toEqual([{ tool: 'qbo_contact_create_customer', account: 'stratify-ca', targetId: r.data.customer.id, outcome: 'ok' }]);
    expect(JSON.stringify(audit) + JSON.stringify(logs)).not.toMatch(/Zed|zed@|555|King/);
    await expect(call('qbo_contact_create_customer', { ...one, input_data: { display_name: 'Bad', additional_params: { email: 'not-an-email' } } })).rejects.toThrow();
    await expect(call('qbo_contact_create_customer', { ...one, input_data: { display_name: '' } })).rejects.toThrow();
  });
});

describe('failures through the live adapter and IntuitHttp', () => {
  const fault = (code: string, Message: string, type = 'ValidationFault') => ({ Fault: { Error: [{ Message, Detail: 'Secret Customer Inc owes $99,999 (secret@client.example)', code }], type }, time: 'now' });
  const resp = (body: unknown, status: number, tid = 'tid-77') => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { intuit_tid: tid } });
  let fetchImpl: ReturnType<typeof vi.fn>;
  const live = (...responses: Array<() => Response>) => {
    const q = [...responses];
    fetchImpl = vi.fn(async () => (q.length > 1 ? q.shift()! : q[0]!)());
    adapterFor = (a) => createLiveQuickBooksAdapter({ account: a, signal: new AbortController().signal, http: createIntuitHttp({ getAccessToken: async () => 'tok', realmId: a.realmId!, env: 'production', fetchImpl: fetchImpl as never, sleep: async () => undefined, log: ctx.log }) });
  };
  const SECRET = /Secret|secret@|99,999/;

  it('a validation Fault on a report becomes a plain account message and one audit row', async () => {
    live(resp(fault('2020', 'Required param missing, need to supply the required value for the API'), 400));
    const r = await call('qbo_accounting_get_balance_sheet', one);
    expect(r.reports).toEqual([]);
    expect(r.accountErrors[0]).toMatchObject({ account: 'stratify-ca', kind: 'upstream_error' });
    expect(r.accountErrors[0].message).toBe('STRATIFY-CA account: QuickBooks could not run the report: Required param missing, need to supply the required value for the API (error code 2020).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit).toEqual([{ tool: 'qbo_accounting_get_balance_sheet', account: 'stratify-ca', outcome: 'error', detail: 'http 400; code 2020; Required param missing, need to supply the required value for the API; tid tid-77' }]);
    expect(audit[0]!.detail!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify([r, audit, logs])).not.toMatch(SECRET);
  });
  it('a missing plan feature or permission says so, and nothing is retried', async () => {
    live(resp(fault('5020', 'Permission Denied Error'), 400));
    const r = await call('qbo_accounting_get_ar_aging_detail', one);
    expect(r.accountErrors[0].message).toBe('STRATIFY-CA account: QuickBooks could not run the report: Permission Denied Error (error code 5020). This may not be available on your QuickBooks plan.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit[0]).toMatchObject({ outcome: 'error', detail: 'http 400; code 5020; Permission Denied Error; tid tid-77' });
  });
  it.each([
    ['text/html', resp('<html>400 Bad Request</html>', 400)],
    ['empty', resp('', 400)],
    ['a Fault with no Error', resp({ Fault: {} }, 400)],
    ['an Error list of junk', resp({ Fault: { Error: [null, 5, 'x'] } }, 400)],
    ['a success status with a broken body', resp('{"QueryResponse":', 200)],
  ])('malformed response (%s) through a read tool: a plain message, no crash, one request, one audit row', async (_n, res) => {
    live(res);
    const r = await call('qbo_catalog_search_products', { ...one, descriptions: ['x'] });
    expect(r.companies).toEqual([]);
    expect(r.accountErrors[0].message).toMatch(/^STRATIFY-CA account: QuickBooks (could not|returned)/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'qbo_catalog_search_products', account: 'stratify-ca', outcome: 'error' });
    expect(audit[0]!.detail).toMatch(/tid tid-77|upstream_error/);
  });
  it('a duplicate-name Fault on create_customer is reported plainly, audited, and never retried', async () => {
    live(resp(fault('6240', 'Duplicate Name Exists Error'), 400));
    const err = (await call('qbo_contact_create_customer', { ...one, input_data: { display_name: 'Secret Customer Inc' } }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('QuickBooks could not create the customer: Duplicate Name Exists Error (error code 6240).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit).toEqual([{ tool: 'qbo_contact_create_customer', account: 'stratify-ca', outcome: 'error', detail: 'http 400; code 6240; Duplicate Name Exists Error; tid tid-77' }]);
    expect(JSON.stringify([err.message, audit, logs])).not.toMatch(SECRET);
  });
  it.each([429, 500, 502, 503])('create_product on HTTP %i is not retried and is audited', async (status) => {
    live(resp({}, status));
    const err = (await call('qbo_catalog_create_product', { ...one, input_data: { name: 'Gadget', unit_price: 1 } }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    // the account lookup is a GET and may be retried; the create itself is a POST and is not
    expect(fetchImpl.mock.calls.filter((c) => (c[1] as RequestInit).method === 'POST')).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ tool: 'qbo_catalog_create_product', outcome: 'error', detail: expect.stringContaining(`http ${status}`) });
  });
  it('create_product creates through the real rules: lookups, then exactly one POST', async () => {
    const accountsBody = { QueryResponse: { Account: [{ Id: '79', Name: 'Sales', AccountType: 'Income', AccountSubType: 'ServiceFeeIncome' }] } };
    live(resp(accountsBody, 200), resp({ Item: { Id: '55', Name: 'Gadget', Type: 'Service', UnitPrice: 1 } }, 200));
    const r = await call('qbo_catalog_create_product', { ...one, input_data: { name: 'Gadget', unit_price: 1 } });
    expect(r.data.product).toMatchObject({ id: '55', name: 'Gadget' });
    const [get, post] = fetchImpl.mock.calls as [string, RequestInit][][] as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(get[1].method).toBe('GET');
    expect(new URL(get[0]).searchParams.get('query')).toContain("AccountType = 'Income'");
    expect(post[1].method).toBe('POST');
    expect(JSON.parse(post[1].body as string)).toEqual({ Name: 'Gadget', Type: 'Service', UnitPrice: 1, IncomeAccountRef: { value: '79' } });
    expect(audit).toEqual([{ tool: 'qbo_catalog_create_product', account: 'stratify-ca', targetId: '55', outcome: 'ok' }]);
  });
  it('a company with no income account is a plain refusal, nothing posted', async () => {
    live(resp({ QueryResponse: {} }, 200));
    await expect(call('qbo_catalog_create_product', { ...one, input_data: { name: 'Gadget', unit_price: 1 } })).rejects.toThrow(/no income account/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit[0]).toMatchObject({ outcome: 'error' });
  });
  it('happy-path logs and audit hold no names, amounts or emails', async () => {
    live(resp({ QueryResponse: { Customer: [{ Id: '3', DisplayName: 'Secret Customer Inc', PrimaryEmailAddr: { Address: 'secret@client.example' } }] } }, 200));
    const r = await call('qbo_contact_search_customer', { ...one, customer_name: 'Secret Customer Inc', customer_email: 'secret@client.example' });
    expect(r.companies[0].data.best_match.display_name).toBe('Secret Customer Inc');
    expect(JSON.stringify([logs, audit])).not.toMatch(SECRET);
  });
  it('a company that needs reconnecting is reported, not called', async () => {
    accounts[0] = { ...accounts[0]!, status: 'needs_reconnect' };
    live(resp({}, 200));
    const r = await call('company_info', one);
    expect(r.accountErrors[0]).toMatchObject({ kind: 'needs_reconnect' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('over MCP', () => {
  it('plain-text tools put the text itself in the content block; the rest are JSON', async () => {
    const server = buildServer(scopeToolContext(ctx, 'intuit'), { baseUrl: 'http://x', defs: quickbooksTools() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const info = await client.callTool({ name: 'company_info', arguments: { account: 'stratify-ca' } });
    expect(info.isError).toBeFalsy();
    expect((info.content as { text: string }[])[0]!.text).toBe('Company Name: Stratify Software Canada Inc. (mock)\nIndustry: Software Publishers');
    const text = await client.callTool({ name: 'qbo_accounting_get_balance_sheet_text', arguments: { account: 'stratify-ca' } });
    expect((text.content as { text: string }[])[0]!.text.startsWith('STATUS: success\n\n## Balance Sheet')).toBe(true);
    const rep = await client.callTool({ name: 'qbo_accounting_get_balance_sheet', arguments: { account: 'stratify-ca' } });
    expect(JSON.parse((rep.content as { text: string }[])[0]!.text).reports[0].reportTitle).toBe('Balance Sheet');
    const bad = await client.callTool({ name: 'qbo_accounting_get_balance_sheet', arguments: { account: 'stratify-ca', accounting_method: 'both' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/accrual/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(21);
  });
});
