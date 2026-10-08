import type { Account } from '../core/contracts/account';

export interface AccountRow {
  id: string;
  provider: Account['provider'];
  email: string;
  label: string;
  org_client_id: string;
  priority: number;
  connected_at: string;
  status: Account['status'];
  granted_scopes: string[] | null;
}

export function accountFromRow(r: AccountRow): Account {
  return {
    id: r.id,
    provider: r.provider,
    email: r.email,
    label: r.label,
    orgClientId: r.org_client_id,
    priority: r.priority,
    connectedAt: new Date(r.connected_at).toISOString(),
    status: r.status,
    grantedScopes: r.granted_scopes ?? [],
  };
}

export function accountToInsertRow(
  a: Omit<Account, 'id' | 'connectedAt'>,
): Omit<AccountRow, 'id' | 'connected_at'> {
  return {
    provider: a.provider,
    email: a.email,
    label: a.label,
    org_client_id: a.orgClientId,
    priority: a.priority,
    status: a.status,
    granted_scopes: a.grantedScopes,
  };
}

/** Store timestamps are epoch milliseconds; the database uses timestamptz. */
export const msToIso = (ms: number): string => new Date(ms).toISOString();
export const isoToMs = (iso: string): number => Date.parse(iso);
