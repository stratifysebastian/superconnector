import type { Product } from './contracts/account';

/** Scope strings exactly as in SPEC.md "Google Cloud setup and scopes". */
export const PRODUCT_SCOPES: Record<Product, string> = {
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

export const PRODUCTS = Object.keys(PRODUCT_SCOPES) as Product[];

export function grantedProducts(grantedScopes: string[]): Product[] {
  const set = new Set(grantedScopes);
  return PRODUCTS.filter((p) => set.has(PRODUCT_SCOPES[p]));
}

export function missingProducts(grantedScopes: string[]): Product[] {
  const granted = new Set(grantedProducts(grantedScopes));
  return PRODUCTS.filter((p) => !granted.has(p));
}
