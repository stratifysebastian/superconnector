import type { Store } from '@/core/contracts/store';

export const MOCK_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
];

const SEEDS = [
  { label: 'stratify', domain: 'stratify.example', email: 'seb@stratify.example' },
  { label: 'prime', domain: 'prime.example', email: 'seb@prime.example' },
];

/** Creates the two fake org clients and connected accounts. Safe to call repeatedly. */
export async function seedMockAccounts(store: Store): Promise<void> {
  for (const s of SEEDS) {
    const existing = (await store.orgClients.list()).find((c) => c.label === s.label);
    const orgClientId = await store.orgClients.upsert({
      ...(existing ? { id: existing.id } : {}),
      label: s.label,
      clientId: `fake-client-id-${s.label}`,
      clientSecret: `fake-client-secret-${s.label}`,
      workspaceDomain: s.domain,
    });
    await store.accounts.upsertOnConnect({
      provider: 'google',
      email: s.email,
      label: s.label,
      orgClientId,
      grantedScopes: [...MOCK_SCOPES],
    });
  }
}
