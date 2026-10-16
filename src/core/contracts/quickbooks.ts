/** QuickBooks Online. Q0 has only CompanyInfo; later phases add their own methods. */
export interface QbCompanyInfo {
  CompanyName?: string;
  LegalName?: string;
  Email?: { Address?: string };
  Country?: string;
  [k: string]: unknown;
}

export interface QuickBooksAdapter {
  companyInfo(): Promise<QbCompanyInfo>;
}
