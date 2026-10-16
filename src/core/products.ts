import type { Product, Provider } from './contracts/account';

export type GoogleProduct = Exclude<Product, 'quickbooks'>;

/** Scope strings exactly as in SPEC.md "Google Cloud setup and scopes". */
export const PRODUCT_SCOPES: Record<GoogleProduct, string> = {
  calendar: 'https://www.googleapis.com/auth/calendar',
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  drive: 'https://www.googleapis.com/auth/drive',
  docs: 'https://www.googleapis.com/auth/documents',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  slides: 'https://www.googleapis.com/auth/presentations',
};

export const IDENTITY_SCOPES = ['openid', 'email'] as const;

/** Seb chose to grant all six products up front (PLAN.md §8). */
export const ALL_SCOPES: string[] = [...IDENTITY_SCOPES, ...Object.values(PRODUCT_SCOPES)];

/** QuickBooks Online Accounting scope: the only product of provider 'intuit'. */
export const QUICKBOOKS_SCOPE = 'com.intuit.quickbooks.accounting';

/** Google's products. PRODUCT_SCOPES and ALL_SCOPES stay Google-only, so the Google consent URL never asks for QuickBooks. */
export const PRODUCTS = Object.keys(PRODUCT_SCOPES) as GoogleProduct[];

/** Products and their scopes for a provider. */
function productScopes(provider: Provider): [Product, string][] {
  if (provider === 'intuit') return [['quickbooks', QUICKBOOKS_SCOPE]];
  if (provider === 'google') return PRODUCTS.map((p) => [p, PRODUCT_SCOPES[p]]);
  return [];
}

export function grantedProducts(grantedScopes: string[], provider: Provider = 'google'): Product[] {
  const set = new Set(grantedScopes);
  return productScopes(provider).filter(([, scope]) => set.has(scope)).map(([p]) => p);
}

export function missingProducts(grantedScopes: string[], provider: Provider = 'google'): Product[] {
  const granted = new Set(grantedProducts(grantedScopes, provider));
  return productScopes(provider).map(([p]) => p).filter((p) => !granted.has(p));
}
