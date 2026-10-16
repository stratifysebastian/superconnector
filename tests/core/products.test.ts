import { describe, expect, it } from 'vitest';
import { ALL_SCOPES, QUICKBOOKS_SCOPE, grantedProducts, missingProducts } from '@/core/products';
import { MOCK_SCOPES } from '@/google/mock/seed';

describe('products', () => {
  it('mock scopes grant all six products', () => {
    expect(grantedProducts(MOCK_SCOPES)).toEqual(['calendar', 'gmail', 'drive', 'docs', 'sheets', 'slides']);
    expect([...ALL_SCOPES].sort()).toEqual([...MOCK_SCOPES].sort());
  });
  it('reports missing products', () => {
    expect(missingProducts(['openid', 'email', 'https://www.googleapis.com/auth/calendar'])).toEqual([
      'gmail', 'drive', 'docs', 'sheets', 'slides',
    ]);
  });
  it('quickbooks is the intuit product, with its own scope', () => {
    expect(QUICKBOOKS_SCOPE).toBe('com.intuit.quickbooks.accounting');
    expect(grantedProducts([QUICKBOOKS_SCOPE], 'intuit')).toEqual(['quickbooks']);
    expect(missingProducts([QUICKBOOKS_SCOPE], 'intuit')).toEqual([]);
    expect(grantedProducts(['openid'], 'intuit')).toEqual([]);
    expect(missingProducts([], 'intuit')).toEqual(['quickbooks']);
  });
  it('Google stays Google: the consent scopes never include QuickBooks and QuickBooks is not a Google product', () => {
    expect(ALL_SCOPES).not.toContain(QUICKBOOKS_SCOPE);
    expect(grantedProducts([QUICKBOOKS_SCOPE])).toEqual([]);
    expect(missingProducts([])).not.toContain('quickbooks');
    expect(grantedProducts(MOCK_SCOPES, 'intuit')).toEqual([]);
  });
});
