import { z } from 'zod';
import type { ToolDef } from '@/core/contracts/tool';
import { grantedProducts, missingProducts } from '@/core/products';

export const listAccountsInput = z.object({});

export function createListAccountsTool(baseUrl: string): ToolDef<typeof listAccountsInput> {
  return {
    name: 'list_accounts',
    description:
      'Lists the connected Google accounts (label, email, priority, status, granted products). Use the label or email as the `account` argument on other tools.',
    input: listAccountsInput,
    kind: 'read',
    async handler(_input, ctx) {
      const accounts = await ctx.store.accounts.list(); // priority order
      return {
        accounts: accounts.map((a, i) => {
          const missing = missingProducts(a.grantedScopes);
          const reconnect = a.status === 'needs_reconnect' || missing.length > 0;
          return {
            label: a.label,
            email: a.email,
            priority: i + 1,
            status: a.status,
            products: grantedProducts(a.grantedScopes),
            missingProducts: missing,
            ...(reconnect ? { reconnectUrl: `${baseUrl}/connect` } : {}),
          };
        }),
      };
    },
  };
}
