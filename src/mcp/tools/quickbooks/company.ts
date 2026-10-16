import { z } from 'zod';
import type { QbCompanyInfo } from '@/core/contracts/quickbooks';
import { FAN_OUT_NOTE, companyField, perCompany, qbTool, textResult } from './common';

const industryOf = (info: QbCompanyInfo): string => {
  const nv = info.NameValue ?? [];
  const hit = nv.find((x) => /^(?:QBO)?IndustryType$/i.test(x.Name ?? '')) ?? nv.find((x) => /industry/i.test(x.Name ?? ''));
  return hit?.Value?.trim() || 'Unknown';
};

export const companyInfoTool = qbTool({
  name: 'company_info',
  description:
    'Get QuickBooks company information. Returns plain text in this exact format:\nCompany Name: <name>\nIndustry: <value>\nThe Industry field is "Unknown" when no industry has been set for the company.' +
    ` With several companies connected, one block per company is returned, each starting with its account label.${FAN_OUT_NOTE.replace(/^ With several[^.]*\./, '')}`,
  input: z.object({ account: companyField }),
  kind: 'read',
  async handler(input, ctx) {
    const r = await perCompany(ctx, 'company_info', input.account, async (qb) => {
      const info = await qb.companyInfo();
      return { text: `Company Name: ${info.CompanyName ?? info.LegalName ?? 'Unknown'}\nIndustry: ${industryOf(info)}` };
    });
    return textResult(r.items.map((i) => ({ account: i.account, text: i.text })), r.accountErrors);
  },
});
