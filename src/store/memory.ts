import { randomUUID } from 'node:crypto';
import type { Cipher } from '../core/contracts/crypto';
import type { Account } from '../core/contracts/account';
import type { OrgClient, Store } from '../core/contracts/store';
import {
  assertLabel,
  assertSameIdSet,
  compareAccounts,
  isStratify,
  truncateDetail,
  uniqueLabel,
} from './shared';

interface OrgRow {
  id: string;
  label: string;
  clientId: string;
  clientSecretEnc: string;
  workspaceDomain: string;
}
interface TokenRow {
  refreshEnc?: string;
  accessEnc?: string;
  accessExpiresAt?: number;
}
interface CodeRow {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  expiresAt: number;
}
interface OAuthTokenRow {
  kind: 'access' | 'refresh';
  clientId: string;
  subject: string;
  expiresAt: number;
  familyId: string;
  revoked: boolean;
}
interface StateRow {
  orgClientId: string;
  accountId?: string;
  expiresAt: number;
}
interface AuditRow {
  at: string;
  tool: string;
  account: string;
  targetId?: string;
  outcome: 'ok' | 'rejected' | 'error';
  detail?: string;
}

export type MemoryStore = Store & { _dump(): unknown };

/** In-memory Store. Secrets are encrypted through `cipher`, so the maps hold ciphertext like the real store. */
export function createMemoryStore(cipher: Cipher): MemoryStore {
  const orgs = new Map<string, OrgRow>();
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, TokenRow>();
  const clients = new Map<string, { clientId: string; redirectUris: string[]; clientName?: string }>();
  const codes = new Map<string, CodeRow>();
  const oauthTokens = new Map<string, OAuthTokenRow>();
  const states = new Map<string, StateRow>();
  const audit: AuditRow[] = [];

  const sorted = () => [...accounts.values()].sort(compareAccounts);
  const copy = (a: Account): Account => ({ ...a, grantedScopes: [...a.grantedScopes] });

  return {
    orgClients: {
      async list() {
        return [...orgs.values()].map(({ id, label, clientId, workspaceDomain }) => ({
          id,
          label,
          clientId,
          workspaceDomain,
        }));
      },
      async get(id): Promise<OrgClient | null> {
        const r = orgs.get(id);
        if (!r) return null;
        return {
          id: r.id,
          label: r.label,
          clientId: r.clientId,
          clientSecret: cipher.decrypt(r.clientSecretEnc),
          workspaceDomain: r.workspaceDomain,
        };
      },
      async upsert(c) {
        const id = c.id ?? randomUUID();
        orgs.set(id, {
          id,
          label: c.label,
          clientId: c.clientId,
          clientSecretEnc: cipher.encrypt(c.clientSecret),
          workspaceDomain: c.workspaceDomain,
        });
        return id;
      },
    },
    accounts: {
      async list() {
        return sorted().map(copy);
      },
      async upsertOnConnect(a) {
        const existing = [...accounts.values()].find((x) => x.provider === a.provider && x.email === a.email);
        if (existing) {
          existing.grantedScopes = [...a.grantedScopes];
          existing.orgClientId = a.orgClientId;
          existing.status = 'active';
          return copy(existing);
        }
        const label = uniqueLabel(a.label, new Set([...accounts.values()].map((x) => x.label)));
        let priority = 0;
        if (isStratify(a.label)) {
          for (const x of accounts.values()) x.priority += 1;
        } else if (accounts.size > 0) {
          priority = Math.max(...[...accounts.values()].map((x) => x.priority)) + 1;
        }
        const created: Account = {
          id: randomUUID(),
          provider: a.provider,
          email: a.email,
          label,
          orgClientId: a.orgClientId,
          priority,
          connectedAt: new Date().toISOString(),
          status: 'active',
          grantedScopes: [...a.grantedScopes],
        };
        accounts.set(created.id, created);
        return copy(created);
      },
      async setStatus(id, s) {
        const a = accounts.get(id);
        if (!a) throw new Error('Account not found');
        a.status = s;
      },
      async reorder(ids) {
        assertSameIdSet(ids, [...accounts.keys()]);
        ids.forEach((id, i) => {
          accounts.get(id)!.priority = i;
        });
      },
      async setLabel(id, label) {
        assertLabel(label);
        const a = accounts.get(id);
        if (!a) throw new Error('Account not found');
        if ([...accounts.values()].some((x) => x.id !== id && x.label === label)) {
          throw new Error('Label already in use');
        }
        a.label = label;
      },
    },
    tokens: {
      async getRefreshToken(id) {
        const r = tokens.get(id)?.refreshEnc;
        return r === undefined ? null : cipher.decrypt(r);
      },
      async setRefreshToken(id, token) {
        tokens.set(id, { ...tokens.get(id), refreshEnc: cipher.encrypt(token) });
      },
      async getCachedAccess(id) {
        const r = tokens.get(id);
        if (r?.accessEnc === undefined || r.accessExpiresAt === undefined) return null;
        return { token: cipher.decrypt(r.accessEnc), expiresAt: r.accessExpiresAt };
      },
      async setCachedAccess(id, token, expiresAt) {
        tokens.set(id, { ...tokens.get(id), accessEnc: cipher.encrypt(token), accessExpiresAt: expiresAt });
      },
    },
    oauth: {
      async createClient(c) {
        const clientId = randomUUID();
        clients.set(clientId, { clientId, redirectUris: [...c.redirectUris], clientName: c.clientName });
        return { clientId };
      },
      async getClient(clientId) {
        const c = clients.get(clientId);
        return c ? { clientId: c.clientId, redirectUris: [...c.redirectUris] } : null;
      },
      async saveCode(c) {
        const { codeHash, ...row } = c;
        codes.set(codeHash, row);
      },
      async consumeCode(codeHash) {
        const r = codes.get(codeHash);
        if (!r) return null;
        codes.delete(codeHash);
        return r.expiresAt > Date.now() ? r : null;
      },
      async saveToken(t) {
        const { tokenHash, ...row } = t;
        oauthTokens.set(tokenHash, { ...row, revoked: false });
      },
      async findToken(tokenHash) {
        const r = oauthTokens.get(tokenHash);
        return r ? { ...r } : null;
      },
      async revokeFamily(familyId) {
        for (const r of oauthTokens.values()) if (r.familyId === familyId) r.revoked = true;
      },
      async saveState(stateHash, data) {
        states.set(stateHash, { ...data });
      },
      async consumeState(stateHash) {
        const r = states.get(stateHash);
        if (!r) return null;
        states.delete(stateHash);
        return r.expiresAt > Date.now() ? r : null;
      },
    },
    audit: {
      async write(e) {
        audit.push({
          at: new Date().toISOString(),
          tool: e.tool,
          account: e.account,
          targetId: e.targetId,
          outcome: e.outcome,
          detail: truncateDetail(e.detail),
        });
      },
    },
    /** Test hook: raw internal state (ciphertext only for secrets). */
    _dump() {
      return {
        orgs: [...orgs.values()],
        tokens: [...tokens.entries()],
        codes: [...codes.entries()],
        oauthTokens: [...oauthTokens.entries()],
        states: [...states.entries()],
        audit: [...audit],
      };
    },
  };
}
