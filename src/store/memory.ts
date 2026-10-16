import { randomUUID } from 'node:crypto';
import type { Cipher } from '../core/contracts/crypto';
import type { Account, Provider } from '../core/contracts/account';
import type { OrgClient, Store } from '../core/contracts/store';
import {
  assertConnectInput,
  assertLabel,
  assertOrgClient,
  assertSameIdSet,
  sameAccount,
  compareAccounts,
  isStratify,
  truncateDetail,
  uniqueLabel,
} from './shared';

interface OrgRow {
  id: string;
  provider: Provider;
  label: string;
  clientId: string;
  clientSecretEnc: string;
  workspaceDomain?: string;
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
  const registrations = new Map<string, { clientId: string; redirectUris: string[]; clientName?: string; createdAt: number }>();
  const codes = new Map<string, CodeRow>();
  const oauthTokens = new Map<string, OAuthTokenRow>();
  const states = new Map<string, StateRow>();
  const audit: AuditRow[] = [];

  const sorted = () => [...accounts.values()].sort(compareAccounts);
  const copy = (a: Account): Account => ({ ...a, grantedScopes: [...a.grantedScopes] });

  return {
    orgClients: {
      async list() {
        return [...orgs.values()].map(({ id, provider, label, clientId, workspaceDomain }) => ({
          id,
          provider,
          label,
          clientId,
          ...(workspaceDomain !== undefined ? { workspaceDomain } : {}),
        }));
      },
      async get(id): Promise<OrgClient | null> {
        const r = orgs.get(id);
        if (!r) return null;
        return {
          id: r.id,
          provider: r.provider,
          label: r.label,
          clientId: r.clientId,
          clientSecret: cipher.decrypt(r.clientSecretEnc),
          ...(r.workspaceDomain !== undefined ? { workspaceDomain: r.workspaceDomain } : {}),
        };
      },
      async upsert(c) {
        const id = c.id ?? randomUUID();
        const provider = c.provider ?? 'google';
        assertOrgClient(provider, c.workspaceDomain, orgs.get(id)?.provider);
        if ([...orgs.values()].some((o) => o.id !== id && o.provider === provider && o.label === c.label)) {
          throw new Error('Org client label already in use');
        }
        orgs.set(id, {
          id,
          provider,
          label: c.label,
          clientId: c.clientId,
          clientSecretEnc: cipher.encrypt(c.clientSecret),
          ...(c.workspaceDomain !== undefined ? { workspaceDomain: c.workspaceDomain } : {}),
        });
        return id;
      },
    },
    accounts: {
      async list() {
        return sorted().map(copy);
      },
      async upsertOnConnect(a) {
        assertConnectInput(a);
        const org = orgs.get(a.orgClientId);
        if (!org) throw new Error('Unknown org client');
        if (org.provider !== a.provider) throw new Error('Org client belongs to a different provider');
        const existing = [...accounts.values()].find((x) => sameAccount(x, a));
        if (existing) {
          existing.grantedScopes = [...a.grantedScopes];
          if (a.companyName !== undefined) existing.companyName = a.companyName;
          existing.orgClientId = a.orgClientId;
          existing.status = 'active';
          return copy(existing);
        }
        const label = uniqueLabel(
          a.label,
          new Set([...accounts.values()].filter((x) => x.provider === a.provider).map((x) => x.label)),
        );
        let priority = 0;
        if (a.provider === 'google' && isStratify(a.label)) {
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
          ...(a.realmId !== undefined ? { realmId: a.realmId } : {}),
          ...(a.companyName !== undefined ? { companyName: a.companyName } : {}),
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
        if ([...accounts.values()].some((x) => x.id !== id && x.provider === a.provider && x.label === label)) {
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
      async swapRefreshToken(id, expected, next) {
        const cur = tokens.get(id)?.refreshEnc;
        if (cur === undefined || cipher.decrypt(cur) !== expected) return false;
        tokens.set(id, { ...tokens.get(id), refreshEnc: cipher.encrypt(next) });
        return true;
      },
      async setCachedAccess(id, token, expiresAt) {
        tokens.set(id, { ...tokens.get(id), accessEnc: cipher.encrypt(token), accessExpiresAt: expiresAt });
      },
    },
    oauth: {
      async createClient(c) {
        const clientId = randomUUID();
        registrations.set(clientId, { clientId, redirectUris: [...c.redirectUris], clientName: c.clientName, createdAt: Date.now() });
        return { clientId };
      },
      async getClient(clientId) {
        const c = registrations.get(clientId);
        if (!c) return null;
        return { clientId: c.clientId, redirectUris: [...c.redirectUris], ...(c.clientName ? { clientName: c.clientName } : {}) };
      },
      async countClients() {
        return registrations.size;
      },
      async saveCode(c) {
        if (!registrations.has(c.clientId)) throw new Error('Unknown OAuth client');
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
        if (!registrations.has(t.clientId)) throw new Error('Unknown OAuth client');
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
      async revokeToken(tokenHash) {
        const r = oauthTokens.get(tokenHash);
        if (!r || r.revoked) return false;
        r.revoked = true;
        return true;
      },
      async revokeAllTokens() {
        let n = 0;
        for (const r of oauthTokens.values()) if (!r.revoked) { r.revoked = true; n++; }
        return n;
      },
      async purgeExpired(now, clientMaxAgeMs) {
        const out = { codes: 0, states: 0, tokens: 0, clients: 0 };
        for (const [k, r] of codes) if (r.expiresAt <= now) { codes.delete(k); out.codes++; }
        for (const [k, r] of states) if (r.expiresAt <= now) { states.delete(k); out.states++; }
        for (const [k, r] of oauthTokens) if (r.expiresAt <= now) { oauthTokens.delete(k); out.tokens++; }
        const inUse = new Set([...oauthTokens.values()].map((r) => r.clientId));
        for (const [k, c] of registrations) {
          if (c.createdAt <= now - clientMaxAgeMs && !inUse.has(k)) {
            registrations.delete(k);
            for (const [ck, cr] of codes) if (cr.clientId === k) codes.delete(ck);
            out.clients++;
          }
        }
        return out;
      },
      async saveState(stateHash, data) {
        if (!orgs.has(data.orgClientId)) throw new Error('Unknown org client');
        if (data.accountId !== undefined && !accounts.has(data.accountId)) throw new Error('Unknown account');
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
      async countToday(p) {
        const since = p.since.getTime();
        return audit.filter((r) => r.outcome === 'ok' && r.tool === p.tool && r.account === p.account && Date.parse(r.at) >= since).length;
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
