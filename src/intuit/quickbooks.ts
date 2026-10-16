import type { IntuitHttp, QuickBooksAdapterContext } from '@/core/contracts/adapter';
import type { QbCompanyInfo, QuickBooksAdapter } from '@/core/contracts/quickbooks';
import { companyPath } from './endpoints';

/** GET CompanyInfo for a company through a guarded IntuitHttp. Shared by the adapter and the connect callback. */
export async function fetchCompanyInfo(http: IntuitHttp, realmId: string): Promise<QbCompanyInfo> {
  const r = await http.json<{ CompanyInfo?: QbCompanyInfo }>({ method: 'GET', path: companyPath(realmId, `companyinfo/${realmId}`) });
  if (!r || typeof r.CompanyInfo !== 'object' || r.CompanyInfo === null) throw new Error('CompanyInfo response was malformed');
  return r.CompanyInfo;
}

export function createLiveQuickBooksAdapter(ctx: QuickBooksAdapterContext): QuickBooksAdapter {
  const realmId = ctx.account.realmId;
  return {
    async companyInfo() {
      if (!realmId) throw new Error('Account has no realmId');
      return fetchCompanyInfo(ctx.http, realmId);
    },
  };
}
