/** QuickBooks Online (public Accounting API v3 and Reports API). Raw shapes are what Intuit returns; tools shape the output. */
export interface QbCompanyInfo {
  CompanyName?: string;
  LegalName?: string;
  Email?: { Address?: string };
  Country?: string;
  NameValue?: { Name?: string; Value?: string }[];
  [k: string]: unknown;
}

export type QbReportName =
  | 'BalanceSheet'
  | 'ProfitAndLoss'
  | 'CashFlow'
  | 'AgedReceivables'
  | 'AgedReceivableDetail'
  | 'AgedPayables'
  | 'AgedPayableDetail'
  | 'CustomerSales'
  | 'ItemSales';

/** Reports API query parameters. Which ones each report may send is fixed in src/intuit/endpoints. */
export interface QbReportParams {
  start_date?: string;
  end_date?: string;
  accounting_method?: 'Accrual' | 'Cash';
  summarize_column_by?: string;
  /** Aging reports only. */
  report_date?: string;
}

export interface QbColData {
  value?: string;
  id?: string;
  href?: string;
}
export interface QbReportRow {
  type?: 'Section' | 'Data' | string;
  group?: string;
  Header?: { ColData?: QbColData[] };
  Rows?: { Row?: QbReportRow[] };
  Summary?: { ColData?: QbColData[] };
  ColData?: QbColData[];
}
/** A Reports API response: Header, Columns and Rows (nested Row/Rows/Summary). */
export interface QbReport {
  Header?: {
    ReportName?: string;
    ReportBasis?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
    Option?: { Name?: string; Value?: string }[];
    [k: string]: unknown;
  };
  Columns?: { Column?: { ColTitle?: string; ColType?: string; MetaData?: { Name?: string; Value?: string }[] }[] };
  Rows?: { Row?: QbReportRow[] };
}

export type QbItemType = 'Service' | 'Inventory' | 'NonInventory';
export interface QbItem {
  Id?: string;
  Name?: string;
  Type?: string;
  Active?: boolean;
  Description?: string;
  Sku?: string;
  UnitPrice?: number;
  QtyOnHand?: number;
  Taxable?: boolean;
  SalesTaxCodeRef?: { value?: string; name?: string };
  [k: string]: unknown;
}
export interface QbCustomer {
  Id?: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Active?: boolean;
  [k: string]: unknown;
}

export interface QbItemCreate {
  name: string;
  type: QbItemType;
  unitPrice: number;
  description?: string;
  sku?: string;
  /** Sent only when the caller asked for it. */
  taxable?: boolean;
  quantityOnHand?: number;
  inventoryStartDate?: string;
}
export interface QbCustomerCreate {
  displayName: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billingAddress?: string;
  shippingAddress?: string;
}

export interface QuickBooksAdapter {
  companyInfo(): Promise<QbCompanyInfo>;
  report(name: QbReportName, params: QbReportParams): Promise<QbReport>;
  /** Active items. `type` narrows by item type. Pages internally. */
  listItems(f?: { type?: QbItemType }): Promise<QbItem[]>;
  /** Active items whose Name contains `term` (LIKE). */
  findItems(term: string): Promise<QbItem[]>;
  /** Active customers: DisplayName contains `name`, and/or the exact primary email. */
  findCustomers(f: { name?: string; email?: string }): Promise<QbCustomer[]>;
  createItem(input: QbItemCreate): Promise<QbItem>;
  createCustomer(input: QbCustomerCreate): Promise<QbCustomer>;
}
