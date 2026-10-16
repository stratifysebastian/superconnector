import type { Store } from '@/core/contracts/store';
import { QUICKBOOKS_SCOPE } from '@/core/products';

export const MOCK_INTUIT = {
  label: 'stratify-ca',
  realmId: 'mock-realm-1',
  email: 'books@stratify-ca.example',
  companyName: 'Stratify Software Canada Inc. (mock)',
};

/** Creates the fake Intuit app client and connected company. Safe to call repeatedly. */
export async function seedMockIntuit(store: Store): Promise<void> {
  const existing = (await store.orgClients.list()).find((c) => c.provider === 'intuit' && c.label === MOCK_INTUIT.label);
  const orgClientId = await store.orgClients.upsert({
    ...(existing ? { id: existing.id } : {}),
    provider: 'intuit',
    label: MOCK_INTUIT.label,
    clientId: 'fake-intuit-client-id',
    clientSecret: 'fake-intuit-client-secret',
  });
  await store.accounts.upsertOnConnect({
    provider: 'intuit',
    email: MOCK_INTUIT.email,
    label: MOCK_INTUIT.label,
    orgClientId,
    grantedScopes: [QUICKBOOKS_SCOPE],
    realmId: MOCK_INTUIT.realmId,
    companyName: MOCK_INTUIT.companyName,
  });
}
