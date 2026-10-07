import type { Account } from './account';

export interface OrgClient {
  id: string;
  label: string;
  clientId: string;
  clientSecret: string; // decrypted in memory only
  workspaceDomain: string;
}

export interface Store {
  orgClients: {
    list(): Promise<Omit<OrgClient, 'clientSecret'>[]>;
    get(id: string): Promise<OrgClient | null>;
    upsert(c: Omit<OrgClient, 'id'> & { id?: string }): Promise<string>;
  };
  accounts: {
    list(): Promise<Account[]>; // priority order
    upsertOnConnect(a: Omit<Account, 'id' | 'priority' | 'connectedAt' | 'status'>): Promise<Account>;
    setStatus(id: string, s: Account['status']): Promise<void>;
    reorder(idsInOrder: string[]): Promise<void>;
    setLabel(id: string, label: string): Promise<void>;
  };
  tokens: {
    getRefreshToken(accountId: string): Promise<string | null>; // decrypted
    setRefreshToken(accountId: string, token: string): Promise<void>; // encrypted at rest
    getCachedAccess(accountId: string): Promise<{ token: string; expiresAt: number } | null>;
    setCachedAccess(accountId: string, token: string, expiresAt: number): Promise<void>;
  };
  oauth: {
    createClient(c: { redirectUris: string[]; clientName?: string }): Promise<{ clientId: string }>;
    getClient(clientId: string): Promise<{ clientId: string; redirectUris: string[] } | null>;
    saveCode(c: {
      codeHash: string;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      subject: string;
      expiresAt: number;
    }): Promise<void>;
    consumeCode(codeHash: string): Promise<{
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      subject: string;
      expiresAt: number;
    } | null>; // single use
    saveToken(t: {
      tokenHash: string;
      kind: 'access' | 'refresh';
      clientId: string;
      subject: string;
      expiresAt: number;
      familyId: string;
    }): Promise<void>;
    findToken(tokenHash: string): Promise<{
      kind: 'access' | 'refresh';
      clientId: string;
      subject: string;
      expiresAt: number;
      familyId: string;
      revoked: boolean;
    } | null>;
    revokeFamily(familyId: string): Promise<void>;
    saveState(stateHash: string, data: { orgClientId: string; accountId?: string; expiresAt: number }): Promise<void>;
    consumeState(stateHash: string): Promise<{ orgClientId: string; accountId?: string; expiresAt: number } | null>;
  };
  audit: {
    write(e: {
      tool: string;
      account: string;
      targetId?: string;
      outcome: 'ok' | 'rejected' | 'error';
      detail?: string;
    }): Promise<void>; // never bodies
  };
}
