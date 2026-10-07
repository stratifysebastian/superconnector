import { beforeEach, describe, expect, it } from 'vitest';
import type { Cipher } from '../../src/core/contracts/crypto';
import type { Store } from '../../src/core/contracts/store';

/** Reversible fake cipher for tests only. */
export const fakeCipher: Cipher = {
  encrypt: (p) => `fake:${Buffer.from(p).toString('base64')}`,
  decrypt: (c) => {
    if (!c.startsWith('fake:')) throw new Error('not fake ciphertext');
    return Buffer.from(c.slice(5), 'base64').toString();
  },
};

export interface StoreHarness {
  store: Store;
  /** Returns the store's raw internal state for plaintext inspection. */
  dump?: () => unknown;
}

const SECRET = 'fake-client-secret-VALUE';
const REFRESH = 'fake-refresh-VALUE';
const ACCESS = 'fake-access-VALUE';

export function runStoreConformance(name: string, makeStore: () => StoreHarness): void {
  describe(`Store conformance: ${name}`, () => {
    let h: StoreHarness;
    let s: Store;
    let org: string;

    const connect = (label: string, email: string, scopes: string[] = ['a']) =>
      s.accounts.upsertOnConnect({ provider: 'google', email, label, orgClientId: org, grantedScopes: scopes });

    beforeEach(async () => {
      h = makeStore();
      s = h.store;
      org = await s.orgClients.upsert({
        label: 'prime',
        clientId: 'fake-client-id',
        clientSecret: SECRET,
        workspaceDomain: 'example.test',
      });
    });

    describe('orgClients', () => {
      it('list never returns the secret; get returns it decrypted', async () => {
        const list = await s.orgClients.list();
        expect(list).toHaveLength(1);
        expect(JSON.stringify(list)).not.toContain(SECRET);
        expect(list[0]).not.toHaveProperty('clientSecret');
        expect((await s.orgClients.get(org))?.clientSecret).toBe(SECRET);
        expect(await s.orgClients.get('00000000-0000-4000-8000-000000000000')).toBeNull();
      });
      it('upsert with an id updates in place', async () => {
        await s.orgClients.upsert({ id: org, label: 'prime2', clientId: 'x', clientSecret: 'y', workspaceDomain: 'd' });
        expect(await s.orgClients.list()).toHaveLength(1);
        expect((await s.orgClients.get(org))?.label).toBe('prime2');
      });
    });

    describe('accounts', () => {
      it('appends in connection order and lists by priority', async () => {
        const a = await connect('prime', 'a@x.test');
        const b = await connect('acme', 'b@x.test');
        expect(a.priority).toBe(0);
        expect(b.priority).toBe(1);
        expect(a.status).toBe('active');
        expect((await s.accounts.list()).map((x) => x.label)).toEqual(['prime', 'acme']);
      });

      it('puts stratify first even when connected second', async () => {
        await connect('prime', 'a@x.test');
        await connect('acme', 'b@x.test');
        const st = await connect('Stratify', 'c@x.test');
        expect(st.priority).toBe(0);
        const list = await s.accounts.list();
        expect(list.map((x) => x.label)).toEqual(['stratify', 'prime', 'acme']);
        expect(list.map((x) => x.priority)).toEqual([0, 1, 2]);
      });

      it('reconnect keeps id, priority and label; updates scopes, org and status', async () => {
        const a = await connect('prime', 'a@x.test', ['one']);
        await connect('acme', 'b@x.test');
        await s.accounts.setStatus(a.id, 'needs_reconnect');
        const org2 = await s.orgClients.upsert({
          label: 'o2',
          clientId: 'c2',
          clientSecret: 's2',
          workspaceDomain: 'd2',
        });
        const again = await s.accounts.upsertOnConnect({
          provider: 'google',
          email: 'a@x.test',
          label: 'something-else',
          orgClientId: org2,
          grantedScopes: ['one', 'two'],
        });
        expect(again.id).toBe(a.id);
        expect(again.priority).toBe(a.priority);
        expect(again.label).toBe('prime');
        expect(again.status).toBe('active');
        expect(again.grantedScopes).toEqual(['one', 'two']);
        expect(again.orgClientId).toBe(org2);
        expect(await s.accounts.list()).toHaveLength(2);
      });

      it('a reconnecting stratify account does not move', async () => {
        await connect('prime', 'a@x.test');
        const st = await connect('stratify', 's@x.test');
        const again = await connect('stratify', 's@x.test');
        expect(again.priority).toBe(st.priority);
        expect((await s.accounts.list()).map((x) => x.label)).toEqual(['stratify', 'prime']);
      });

      it('suffixes colliding labels with -2, -3', async () => {
        const a = await connect('prime', 'a@x.test');
        const b = await connect('prime', 'b@x.test');
        const c = await connect('prime', 'c@x.test');
        expect([a.label, b.label, c.label]).toEqual(['prime', 'prime-2', 'prime-3']);
      });

      it('setStatus changes status', async () => {
        const a = await connect('prime', 'a@x.test');
        await s.accounts.setStatus(a.id, 'needs_reconnect');
        expect((await s.accounts.list())[0]?.status).toBe('needs_reconnect');
      });

      it('reorder rewrites priorities 0..n-1', async () => {
        const a = await connect('prime', 'a@x.test');
        const b = await connect('acme', 'b@x.test');
        const c = await connect('zeta', 'c@x.test');
        await s.accounts.reorder([c.id, a.id, b.id]);
        const list = await s.accounts.list();
        expect(list.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
        expect(list.map((x) => x.priority)).toEqual([0, 1, 2]);
      });

      it('reorder rejects missing, extra, duplicate and unknown ids', async () => {
        const a = await connect('prime', 'a@x.test');
        const b = await connect('acme', 'b@x.test');
        await expect(s.accounts.reorder([a.id])).rejects.toThrow();
        await expect(s.accounts.reorder([a.id, b.id, a.id])).rejects.toThrow();
        await expect(s.accounts.reorder([a.id, a.id])).rejects.toThrow();
        await expect(s.accounts.reorder([a.id, '00000000-0000-4000-8000-000000000000'])).rejects.toThrow();
        expect((await s.accounts.list()).map((x) => x.id)).toEqual([a.id, b.id]);
      });

      it('setLabel enforces uniqueness and pattern', async () => {
        const a = await connect('prime', 'a@x.test');
        const b = await connect('acme', 'b@x.test');
        await expect(s.accounts.setLabel(b.id, 'prime')).rejects.toThrow();
        await expect(s.accounts.setLabel(b.id, 'Bad Label')).rejects.toThrow();
        await expect(s.accounts.setLabel(b.id, '-lead')).rejects.toThrow();
        await expect(s.accounts.setLabel(b.id, '')).rejects.toThrow();
        await expect(s.accounts.setLabel(b.id, 'a'.repeat(33))).rejects.toThrow();
        await s.accounts.setLabel(b.id, 'a'.repeat(32));
        await s.accounts.setLabel(a.id, 'prime'); // own label is fine
        await s.accounts.setLabel(a.id, 'main-1');
        expect((await s.accounts.list()).map((x) => x.label)).toEqual(['main-1', 'a'.repeat(32)]);
      });
    });

    describe('tokens', () => {
      it('round-trips refresh and cached access tokens', async () => {
        const a = await connect('prime', 'a@x.test');
        expect(await s.tokens.getRefreshToken(a.id)).toBeNull();
        expect(await s.tokens.getCachedAccess(a.id)).toBeNull();
        await s.tokens.setRefreshToken(a.id, REFRESH);
        await s.tokens.setCachedAccess(a.id, ACCESS, 1234567);
        expect(await s.tokens.getRefreshToken(a.id)).toBe(REFRESH);
        expect(await s.tokens.getCachedAccess(a.id)).toEqual({ token: ACCESS, expiresAt: 1234567 });
        await s.tokens.setRefreshToken(a.id, 'fake-refresh-2');
        expect(await s.tokens.getCachedAccess(a.id)).toEqual({ token: ACCESS, expiresAt: 1234567 });
      });
    });

    describe('oauth', () => {
      const future = () => Date.now() + 60_000;
      const past = () => Date.now() - 1_000;

      it('creates and finds clients', async () => {
        const { clientId } = await s.oauth.createClient({ redirectUris: ['https://app.test/cb'], clientName: 'n' });
        expect(await s.oauth.getClient(clientId)).toEqual({ clientId, redirectUris: ['https://app.test/cb'] });
        expect(await s.oauth.getClient('00000000-0000-4000-8000-000000000000')).toBeNull();
      });

      it('codes are single use', async () => {
        const { clientId } = await s.oauth.createClient({ redirectUris: ['https://app.test/cb'] });
        const exp = future();
        await s.oauth.saveCode({
          codeHash: 'hash-code-1',
          clientId,
          redirectUri: 'https://app.test/cb',
          codeChallenge: 'chal',
          subject: 'seb@x.test',
          expiresAt: exp,
        });
        const first = await s.oauth.consumeCode('hash-code-1');
        expect(first).toMatchObject({
          clientId,
          redirectUri: 'https://app.test/cb',
          codeChallenge: 'chal',
          subject: 'seb@x.test',
        });
        expect(Math.abs((first?.expiresAt ?? 0) - exp)).toBeLessThan(2);
        expect(await s.oauth.consumeCode('hash-code-1')).toBeNull();
        expect(await s.oauth.consumeCode('never-saved')).toBeNull();
      });

      it('concurrent consumeCode yields exactly one winner', async () => {
        const { clientId } = await s.oauth.createClient({ redirectUris: ['https://app.test/cb'] });
        await s.oauth.saveCode({
          codeHash: 'hash-code-race',
          clientId,
          redirectUri: 'https://app.test/cb',
          codeChallenge: 'c',
          subject: 'u',
          expiresAt: future(),
        });
        const results = await Promise.all([s.oauth.consumeCode('hash-code-race'), s.oauth.consumeCode('hash-code-race')]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
      });

      it('expired codes return null', async () => {
        const { clientId } = await s.oauth.createClient({ redirectUris: ['https://app.test/cb'] });
        await s.oauth.saveCode({
          codeHash: 'hash-code-old',
          clientId,
          redirectUri: 'https://app.test/cb',
          codeChallenge: 'c',
          subject: 'u',
          expiresAt: past(),
        });
        expect(await s.oauth.consumeCode('hash-code-old')).toBeNull();
      });

      it('state is single use and expires', async () => {
        await s.oauth.saveState('hash-state-1', { orgClientId: org, expiresAt: future() });
        const acct = await connect('prime', 'a@x.test');
        await s.oauth.saveState('hash-state-2', { orgClientId: org, accountId: acct.id, expiresAt: future() });
        await s.oauth.saveState('hash-state-3', { orgClientId: org, expiresAt: past() });
        const one = await s.oauth.consumeState('hash-state-1');
        expect(one?.orgClientId).toBe(org);
        expect(one?.accountId).toBeUndefined();
        expect(await s.oauth.consumeState('hash-state-1')).toBeNull();
        expect((await s.oauth.consumeState('hash-state-2'))?.accountId).toBe(acct.id);
        expect(await s.oauth.consumeState('hash-state-3')).toBeNull();
      });

      it('findToken reports revoked; revokeFamily revokes the whole family only', async () => {
        const { clientId } = await s.oauth.createClient({ redirectUris: ['https://app.test/cb'] });
        const t = (tokenHash: string, kind: 'access' | 'refresh', familyId: string) =>
          s.oauth.saveToken({ tokenHash, kind, clientId, subject: 'u', expiresAt: future(), familyId });
        await t('h-a1', 'access', 'fam-a');
        await t('h-a2', 'refresh', 'fam-a');
        await t('h-b1', 'refresh', 'fam-b');
        const before = await s.oauth.findToken('h-a1');
        expect(before).toMatchObject({ kind: 'access', clientId, subject: 'u', familyId: 'fam-a', revoked: false });
        expect(await s.oauth.findToken('nope')).toBeNull();
        await s.oauth.revokeFamily('fam-a');
        expect((await s.oauth.findToken('h-a1'))?.revoked).toBe(true);
        expect((await s.oauth.findToken('h-a2'))?.revoked).toBe(true);
        expect((await s.oauth.findToken('h-b1'))?.revoked).toBe(false);
      });
    });

    describe('audit', () => {
      it('writes without throwing', async () => {
        await s.audit.write({ tool: 'create_draft', account: 'prime', targetId: 'd1', outcome: 'ok', detail: 'x'.repeat(500) });
        await s.audit.write({ tool: 'create_event', account: 'prime', outcome: 'rejected' });
      });
    });

    describe('encryption at rest', () => {
      it('does not hold secrets in plaintext', async () => {
        const a = await connect('prime', 'a@x.test');
        await s.tokens.setRefreshToken(a.id, REFRESH);
        await s.tokens.setCachedAccess(a.id, ACCESS, 99);
        if (!h.dump) return; // real databases are checked by the SQL lint test
        const raw = JSON.stringify(h.dump());
        for (const v of [SECRET, REFRESH, ACCESS]) expect(raw).not.toContain(v);
        expect(raw).toContain('fake:');
      });
    });
  });
}
