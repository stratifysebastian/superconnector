import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cipher } from '../core/contracts/crypto';
import type { OrgClient, Store } from '../core/contracts/store';
import { accountFromRow, accountToInsertRow, isoToMs, msToIso, type AccountRow } from './mapping';
import { assertLabel, assertSameIdSet, isStratify, truncateDetail, uniqueLabel } from './shared';

/** Throws a plain error (message only, never row data) if the PostgREST call failed. */
function ok<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Store ${what} failed: ${res.error.message}`);
  return res.data as T;
}

/** Supabase-backed Store. Server only, service role client. */
export function createSupabaseStore(db: SupabaseClient, cipher: Cipher): Store {
  const listAccountRows = async (): Promise<AccountRow[]> =>
    ok(
      await db.from('accounts').select('*').order('priority', { ascending: true }).order('connected_at', { ascending: true }),
      'accounts.list',
    ) as AccountRow[];

  const consume = async (table: string, col: string, hash: string) => {
    const rows = ok(
      await db.from(table).delete().eq(col, hash).gt('expires_at', new Date().toISOString()).select(),
      `${table}.consume`,
    ) as Record<string, unknown>[];
    return rows[0] ?? null;
  };

  return {
    orgClients: {
      async list() {
        const rows = ok(
          await db.from('google_org_clients').select('id,label,client_id,workspace_domain').order('created_at'),
          'orgClients.list',
        ) as { id: string; label: string; client_id: string; workspace_domain: string }[];
        return rows.map((r) => ({
          id: r.id,
          label: r.label,
          clientId: r.client_id,
          workspaceDomain: r.workspace_domain,
        }));
      },
      async get(id): Promise<OrgClient | null> {
        const r = ok(
          await db.from('google_org_clients').select('*').eq('id', id).maybeSingle(),
          'orgClients.get',
        ) as { id: string; label: string; client_id: string; client_secret_enc: string; workspace_domain: string } | null;
        if (!r) return null;
        return {
          id: r.id,
          label: r.label,
          clientId: r.client_id,
          clientSecret: cipher.decrypt(r.client_secret_enc),
          workspaceDomain: r.workspace_domain,
        };
      },
      async upsert(c) {
        const id = c.id ?? randomUUID();
        const clash = ok(
          await db.from('google_org_clients').select('id').eq('label', c.label).neq('id', id).limit(1),
          'orgClients.upsert',
        ) as { id: string }[];
        if (clash.length > 0) throw new Error('Org client label already in use');
        // The unique constraint remains the backstop for concurrent writes.
        ok(
          await db.from('google_org_clients').upsert({
            id,
            label: c.label,
            client_id: c.clientId,
            client_secret_enc: cipher.encrypt(c.clientSecret),
            workspace_domain: c.workspaceDomain,
            updated_at: new Date().toISOString(),
          }),
          'orgClients.upsert',
        );
        return id;
      },
    },
    accounts: {
      async list() {
        return (await listAccountRows()).map(accountFromRow);
      },
      async upsertOnConnect(a) {
        const existing = ok(
          await db.from('accounts').select('*').eq('provider', a.provider).eq('email', a.email).maybeSingle(),
          'accounts.find',
        ) as AccountRow | null;
        if (existing) {
          const row = ok(
            await db
              .from('accounts')
              .update({ granted_scopes: a.grantedScopes, org_client_id: a.orgClientId, status: 'active' })
              .eq('id', existing.id)
              .select()
              .single(),
            'accounts.reconnect',
          ) as AccountRow;
          return accountFromRow(row);
        }
        const all = await listAccountRows();
        const label = uniqueLabel(a.label, new Set(all.map((x) => x.label)));
        let priority = 0;
        if (isStratify(a.label)) {
          for (const x of all) {
            ok(await db.from('accounts').update({ priority: x.priority + 1 }).eq('id', x.id), 'accounts.shift');
          }
        } else if (all.length > 0) {
          priority = Math.max(...all.map((x) => x.priority)) + 1;
        }
        const row = ok(
          await db
            .from('accounts')
            .insert(
              accountToInsertRow({
                provider: a.provider,
                email: a.email,
                label,
                orgClientId: a.orgClientId,
                priority,
                status: 'active',
                grantedScopes: a.grantedScopes,
              }),
            )
            .select()
            .single(),
          'accounts.insert',
        ) as AccountRow;
        return accountFromRow(row);
      },
      async setStatus(id, s) {
        ok(await db.from('accounts').update({ status: s }).eq('id', id), 'accounts.setStatus');
      },
      async reorder(ids) {
        assertSameIdSet(ids, (await listAccountRows()).map((r) => r.id));
        for (let i = 0; i < ids.length; i++) {
          ok(await db.from('accounts').update({ priority: i }).eq('id', ids[i]), 'accounts.reorder');
        }
      },
      async setLabel(id, label) {
        assertLabel(label);
        const clash = ok(
          await db.from('accounts').select('id').eq('label', label).neq('id', id).limit(1),
          'accounts.setLabel',
        ) as { id: string }[];
        if (clash.length > 0) throw new Error('Label already in use');
        // The unique constraint remains the backstop for concurrent renames.
        ok(await db.from('accounts').update({ label }).eq('id', id), 'accounts.setLabel');
      },
    },
    tokens: {
      async getRefreshToken(id) {
        const r = ok(
          await db.from('account_tokens').select('refresh_token_enc').eq('account_id', id).maybeSingle(),
          'tokens.getRefresh',
        ) as { refresh_token_enc: string | null } | null;
        return r?.refresh_token_enc ? cipher.decrypt(r.refresh_token_enc) : null;
      },
      async setRefreshToken(id, token) {
        ok(
          await db
            .from('account_tokens')
            .upsert({ account_id: id, refresh_token_enc: cipher.encrypt(token), updated_at: new Date().toISOString() }),
          'tokens.setRefresh',
        );
      },
      async getCachedAccess(id) {
        const r = ok(
          await db.from('account_tokens').select('access_token_enc,access_expires_at').eq('account_id', id).maybeSingle(),
          'tokens.getAccess',
        ) as { access_token_enc: string | null; access_expires_at: string | null } | null;
        if (!r?.access_token_enc || !r.access_expires_at) return null;
        return { token: cipher.decrypt(r.access_token_enc), expiresAt: isoToMs(r.access_expires_at) };
      },
      async setCachedAccess(id, token, expiresAt) {
        ok(
          await db.from('account_tokens').upsert({
            account_id: id,
            access_token_enc: cipher.encrypt(token),
            access_expires_at: msToIso(expiresAt),
            updated_at: new Date().toISOString(),
          }),
          'tokens.setAccess',
        );
      },
    },
    oauth: {
      async createClient(c) {
        const r = ok(
          await db
            .from('oauth_clients')
            .insert({ redirect_uris: c.redirectUris, client_name: c.clientName ?? null })
            .select('id')
            .single(),
          'oauth.createClient',
        ) as { id: string };
        return { clientId: r.id };
      },
      async getClient(clientId) {
        const r = ok(
          await db.from('oauth_clients').select('id,redirect_uris').eq('id', clientId).maybeSingle(),
          'oauth.getClient',
        ) as { id: string; redirect_uris: string[] } | null;
        return r ? { clientId: r.id, redirectUris: r.redirect_uris } : null;
      },
      async saveCode(c) {
        ok(
          await db.from('oauth_codes').insert({
            code_hash: c.codeHash,
            client_id: c.clientId,
            redirect_uri: c.redirectUri,
            code_challenge: c.codeChallenge,
            subject: c.subject,
            expires_at: msToIso(c.expiresAt),
          }),
          'oauth.saveCode',
        );
      },
      async consumeCode(codeHash) {
        const r = (await consume('oauth_codes', 'code_hash', codeHash)) as {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          subject: string;
          expires_at: string;
        } | null;
        if (!r) return null;
        return {
          clientId: r.client_id,
          redirectUri: r.redirect_uri,
          codeChallenge: r.code_challenge,
          subject: r.subject,
          expiresAt: isoToMs(r.expires_at),
        };
      },
      async saveToken(t) {
        ok(
          await db.from('oauth_tokens').insert({
            token_hash: t.tokenHash,
            kind: t.kind,
            client_id: t.clientId,
            subject: t.subject,
            expires_at: msToIso(t.expiresAt),
            family_id: t.familyId,
          }),
          'oauth.saveToken',
        );
      },
      async findToken(tokenHash) {
        const r = ok(
          await db.from('oauth_tokens').select('*').eq('token_hash', tokenHash).maybeSingle(),
          'oauth.findToken',
        ) as {
          kind: 'access' | 'refresh';
          client_id: string;
          subject: string;
          expires_at: string;
          family_id: string;
          revoked: boolean;
        } | null;
        if (!r) return null;
        return {
          kind: r.kind,
          clientId: r.client_id,
          subject: r.subject,
          expiresAt: isoToMs(r.expires_at),
          familyId: r.family_id,
          revoked: r.revoked,
        };
      },
      async revokeFamily(familyId) {
        ok(await db.from('oauth_tokens').update({ revoked: true }).eq('family_id', familyId), 'oauth.revokeFamily');
      },
      async saveState(stateHash, data) {
        ok(
          await db.from('oauth_state').insert({
            state_hash: stateHash,
            org_client_id: data.orgClientId,
            account_id: data.accountId ?? null,
            expires_at: msToIso(data.expiresAt),
          }),
          'oauth.saveState',
        );
      },
      async consumeState(stateHash) {
        const r = (await consume('oauth_state', 'state_hash', stateHash)) as {
          org_client_id: string;
          account_id: string | null;
          expires_at: string;
        } | null;
        if (!r) return null;
        return {
          orgClientId: r.org_client_id,
          ...(r.account_id ? { accountId: r.account_id } : {}),
          expiresAt: isoToMs(r.expires_at),
        };
      },
    },
    audit: {
      async write(e) {
        ok(
          await db.from('audit_log').insert({
            tool: e.tool,
            account: e.account,
            target_id: e.targetId ?? null,
            outcome: e.outcome,
            detail: truncateDetail(e.detail) ?? null,
          }),
          'audit.write',
        );
      },
    },
  };
}
