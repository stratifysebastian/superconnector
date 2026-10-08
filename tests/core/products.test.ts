import { describe, expect, it } from 'vitest';
import { ALL_SCOPES, grantedProducts, missingProducts } from '@/core/products';
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
});
