import type { IntuitHttp, QuickBooksAdapterContext } from '@/core/contracts/adapter';
import type {
  QbCompanyInfo, QbCustomer, QbCustomerCreate, QbItem, QbItemCreate, QbReport, QbReportName, QbReportParams, QuickBooksAdapter,
} from '@/core/contracts/quickbooks';
import { ProviderError } from '@/core/errors';
import { companyPath } from './endpoints';
import { PAGE, accountsQuery, customersQuery, itemsQuery } from './query';

/** GET CompanyInfo for a company through a guarded IntuitHttp. Shared by the adapter and the connect callback. */
export async function fetchCompanyInfo(http: IntuitHttp, realmId: string): Promise<QbCompanyInfo> {
  const r = await http.json<{ CompanyInfo?: QbCompanyInfo }>({ method: 'GET', path: companyPath(realmId, `companyinfo/${realmId}`) });
  if (!r || typeof r.CompanyInfo !== 'object' || r.CompanyInfo === null) throw new Error('CompanyInfo response was malformed');
  return r.CompanyInfo;
}

export interface AccountRefs {
  income: string;
  asset?: string;
  expense?: string;
}

/** The Item create body. Taxable is sent only when the caller set it; no tax-code fields are ever sent. */
export function itemBody(i: QbItemCreate, refs: AccountRefs): Record<string, unknown> {
  const inventory = i.type === 'Inventory';
  return {
    Name: i.name,
    Type: i.type,
    UnitPrice: i.unitPrice,
    IncomeAccountRef: { value: refs.income },
    ...(i.description ? { Description: i.description } : {}),
    ...(i.sku ? { Sku: i.sku } : {}),
    ...(i.taxable !== undefined ? { Taxable: i.taxable } : {}),
    ...(inventory
      ? {
          TrackQtyOnHand: true,
          QtyOnHand: i.quantityOnHand ?? 0,
          ...(i.inventoryStartDate ? { InvStartDate: i.inventoryStartDate } : {}),
          ...(refs.asset ? { AssetAccountRef: { value: refs.asset } } : {}),
          ...(refs.expense ? { ExpenseAccountRef: { value: refs.expense } } : {}),
        }
      : {}),
  };
}

/** The Customer create body. Free-form addresses go in Line1 as typed. */
export function customerBody(c: QbCustomerCreate): Record<string, unknown> {
  return {
    DisplayName: c.displayName,
    ...(c.firstName ? { GivenName: c.firstName } : {}),
    ...(c.lastName ? { FamilyName: c.lastName } : {}),
    ...(c.companyName ? { CompanyName: c.companyName } : {}),
    ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
    ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    ...(c.billingAddress ? { BillAddr: { Line1: c.billingAddress } } : {}),
    ...(c.shippingAddress ? { ShipAddr: { Line1: c.shippingAddress } } : {}),
  };
}

export function createLiveQuickBooksAdapter(ctx: QuickBooksAdapterContext): QuickBooksAdapter {
  const realmId = ctx.account.realmId;
  const need = (): string => {
    if (!realmId) throw new Error('Account has no realmId');
    return realmId;
  };
  const query = async <T>(text: string, entity: string): Promise<T[]> => {
    const r = await ctx.http.json<{ QueryResponse?: Record<string, unknown> }>({ method: 'GET', path: companyPath(need(), 'query'), query: { query: text } });
    const rows = r?.QueryResponse?.[entity];
    return Array.isArray(rows) ? (rows as T[]) : [];
  };
  const refsFor = async (type: QbItemCreate['type']): Promise<AccountRefs> => {
    const pick = async (kind: Parameters<typeof accountsQuery>[0], sub: string) => {
      const rows = await query<{ Id?: string; AccountType?: string; AccountSubType?: string }>(accountsQuery(kind), 'Account');
      const exact = rows.find((a) => a.Id && a.AccountSubType === sub);
      // Income may fall back to another Income-type account; asset and cost accounts never fall back (a wrong GL account is irreversible).
      return (exact ?? (kind === 'Income' ? rows.find((a) => a.Id && a.AccountType === 'Income') : undefined))?.Id;
    };
    const income = await pick('Income', type === 'Service' ? 'ServiceFeeIncome' : 'SalesOfProductIncome');
    if (!income) throw new ProviderError('upstream_error', 'This QuickBooks company has no income account to attach the new product or service to. Add an Income account in QuickBooks, then try again.');
    if (type !== 'Inventory') return { income };
    const asset = await pick('Other Current Asset', 'Inventory');
    if (!asset) throw new ProviderError('upstream_error', 'This QuickBooks company has no Inventory asset account (an Other Current Asset account with the Inventory detail type). Set one up in QuickBooks, then try again.');
    const expense = await pick('Cost of Goods Sold', 'SuppliesMaterialsCogs');
    if (!expense) throw new ProviderError('upstream_error', 'This QuickBooks company has no Cost of Goods Sold account with the "Supplies & materials - COS" detail type. Set one up in QuickBooks, then try again.');
    return { income, asset, expense };
  };
  const create = async <T>(entity: 'item' | 'customer', body: Record<string, unknown>, key: string): Promise<T> => {
    const r = await ctx.http.json<Record<string, T | undefined>>({ method: 'POST', path: companyPath(need(), entity), body });
    const out = r?.[key];
    if (!out || typeof out !== 'object') throw new ProviderError('upstream_error', 'QuickBooks returned an unreadable response for the new record. It may have been created; check QuickBooks before trying again.');
    return out;
  };
  return {
    async companyInfo() {
      return fetchCompanyInfo(ctx.http, need());
    },
    async report(name: QbReportName, params: QbReportParams) {
      return ctx.http.json<QbReport>({ method: 'GET', path: companyPath(need(), `reports/${name}`), query: { ...params } });
    },
    async listItems(f) {
      const all: QbItem[] = [];
      // shortcut: five pages (5,000 items) is the ceiling; raise it if a company ever needs more.
      for (let start = 1, page = 0; page < 5; page++, start += PAGE) {
        if (ctx.signal.aborted) throw new ProviderError('timeout', 'QuickBooks request timed out.');
        const rows = await query<QbItem>(itemsQuery({ ...(f?.type ? { type: f.type } : {}), start }), 'Item');
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    },
    findItems: (term) => query<QbItem>(itemsQuery({ nameContains: term, max: 20 }), 'Item'),
    async findCustomers(f) {
      const byName = f.name ? await query<QbCustomer>(customersQuery({ nameContains: f.name }), 'Customer') : [];
      const byEmail = f.email ? await query<QbCustomer>(customersQuery({ email: f.email }), 'Customer') : [];
      const seen = new Set<string>();
      return [...byName, ...byEmail].filter((c) => !c.Id || (!seen.has(c.Id) && seen.add(c.Id)));
    },
    async createItem(input) {
      return create<QbItem>('item', itemBody(input, await refsFor(input.type)), 'Item');
    },
    createCustomer: (input) => create<QbCustomer>('customer', customerBody(input), 'Customer'),
  };
}
