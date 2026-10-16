import type { QuickBooksAdapterContext } from '@/core/contracts/adapter';
import type { QbCompanyInfo, QuickBooksAdapter } from '@/core/contracts/quickbooks';
import { loadFixture } from '@/google/mock/fixtures';

/** Reads fixtures/quickbooks/<label>/companyinfo.json. Never touches the network. */
export function createMockQuickBooksAdapter(ctx: QuickBooksAdapterContext): QuickBooksAdapter {
  return {
    async companyInfo() {
      return loadFixture<QbCompanyInfo>('quickbooks', ctx.account.label, 'companyinfo');
    },
  };
}
