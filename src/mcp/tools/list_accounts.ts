import { z } from 'zod';
import type { ToolDef } from '@/core/contracts/tool';
import { grantedProducts, missingProducts } from '@/core/products';

export const listAccountsInput = z.object({});

export function createListAccountsTool(baseUrl: string): ToolDef<typeof listAccountsInput> {
  return {
    name: 'list_accounts',
    description:
      'Lists the connected accounts (provider, label, email, priority, status, granted products): Google accounts and QuickBooks companies. Use the label or email as the `account` argument on other tools.',
    input: listAccountsInput,
    kind: 'read',
    provider: 'any', // the only tool that lists every provider
    async handler(_input, ctx) {
      const accounts = await ctx.store.accounts.list(); // priority order
      return {
        accounts: accounts.map((a, i) => {
          const missing = missingProducts(a.grantedScopes, a.provider);
          const reconnect = a.status === 'needs_reconnect' || missing.length > 0;
          return {
            provider: a.provider,
            label: a.label,
            email: a.email,
            priority: i + 1,
            status: a.status,
            products: grantedProducts(a.grantedScopes, a.provider),
            missingProducts: missing,
            ...(reconnect ? { reconnectUrl: `${baseUrl}/connect` } : {}),
          };
        }),
      };
    },
  };
}
