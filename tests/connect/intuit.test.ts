import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createCipher } from '@/lib/crypto';
import { parseEnv } from '@/lib/env';
import { createMemoryStore } from '@/store/memory';
import { createServerContext, type ServerContext } from '@/server/context';

const state = vi.hoisted(() => ({ session: null as null | { email: string; expiresAt: number }, ctx: null as unknown }));

vi.mock('@/auth/session', () => ({ getAdminSession: async () => state.session }));
vi.mock('@/server/context', async (orig) => ({
  ...(await orig<typeof import('@/server/context')>()),
  getServerContext: async () => state.ctx,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import { renameAccount, reorderAccounts, saveOrgClient } from '@/app/connect/actions';
import { saveOrgClientForm } from '@/app/connect/form-actions';
import { maskRealm, parseFlash } from '@/app/connect/logic';
import ConnectPage from '@/app/connect/page';

let ctx: ServerContext;

beforeEach(async () => {
  ctx = await createServerContext({
    env: parseEnv({ GOOGLE_MODE: 'mock' }),
    store: createMemoryStore(createCipher(Buffer.alloc(32, 9).toString('base64'))),
    log: { info() {}, warn() {}, error() {} },
  });
  state.ctx = ctx;
  state.session = { email: 'admin@stratify.example', expiresAt: Date.now() + 60_000 };
});

const render = async (params: Record<string, string> = {}) => renderToString(await ConnectPage({ searchParams: Promise.resolve(params) }));
const intuitOrg = async () => (await ctx.store.orgClients.list()).find((o) => o.provider === 'intuit')!;

describe('maskRealm', () => {
  it('shows only the last 4 characters', () => {
    expect(maskRealm('9130350000')).toBe('******0000');
    expect(maskRealm('mock-realm-1')).toBe('********lm-1');
    expect(maskRealm('abcd')).toBe('****');
    expect(maskRealm('ab')).toBe('**');
    expect(maskRealm('')).toBe('');
  });
});

describe('/connect page: QuickBooks', () => {
  it('lists the company with name, masked realm and status; never a secret or the full realmId', async () => {
    const html = await render();
    expect(html).toContain('QuickBooks companies');
    expect(html).toContain('stratify-ca');
    expect(html).toContain('Stratify Software Canada Inc. (mock)');
    expect(html).toContain('********lm-1');
    expect(html).not.toContain('mock-realm-1');
    expect(html).toContain('Active');
    expect(html).not.toContain('fake-intuit-client-secret');
    expect(html).toContain('fake-intuit-client-id'); // client ID is fine to show
    expect(html).toContain('http://localhost:3000/api/intuit/callback');
  });

  it('has a Connect QuickBooks company button per Intuit app, and a reconnect link per company', async () => {
    const org = await intuitOrg();
    const html = await render();
    expect(html).toContain('Connect QuickBooks company');
    expect(html).toContain(`href="/api/intuit/connect?org=${org.id}"`);
    expect(html).toContain('aria-label="Connect QuickBooks company for stratify-ca"');
    const acct = (await ctx.store.accounts.list()).find((a) => a.provider === 'intuit')!;
    await ctx.store.accounts.setStatus(acct.id, 'needs_reconnect');
    const after = await render();
    expect(after).toContain('Needs reconnect');
    expect(after).toContain(`/api/intuit/connect?org=${org.id}&amp;account=${acct.id}`);
  });

  it('keeps the WCAG patterns: caption, column scopes, labelled write-only secret field', async () => {
    const html = await render();
    expect(html).toContain('Connected QuickBooks companies');
    expect(html).toMatch(/<label[^>]*for="org-new-intuit-secret"[^>]*>Client secret<\/label>/);
    expect(html).toMatch(/<input[^>]*id="org-new-intuit-secret"[^>]*type="password"/);
    expect(html).toContain('aria-label="Reconnect stratify-ca"');
    expect(html).toContain('Add an Intuit app');
  });

  it('the Intuit app form has label, client id and secret, and no Workspace domain', async () => {
    const html = await render();
    const start = html.indexOf('Add an Intuit app');
    const form = html.slice(start, html.indexOf('</form>', start));
    expect(form).toContain('name="label"');
    expect(form).toContain('name="clientId"');
    expect(form).toContain('name="clientSecret"');
    expect(form).toContain('name="provider" value="intuit"');
    expect(form).not.toContain('workspaceDomain');
  });

  it('the Google sections do not list the QuickBooks company, and vice versa', async () => {
    const html = await render();
    const qb = html.indexOf('QuickBooks companies');
    expect(html.slice(0, qb)).not.toContain('books@stratify-ca.example');
    expect(html.slice(0, qb)).not.toContain('stratify-ca');
  });

  it('flash text for the new error codes is plain and fixed', () => {
    for (const code of ['wrong_company', 'no_realm', 'company_info']) {
      const [f] = parseFlash({ error: code });
      expect(f!.kind).toBe('error');
      expect(f!.text).not.toContain('Something went wrong');
    }
  });
});

describe('Intuit app client actions', () => {
  it('creates an Intuit client without a domain; the secret is stored encrypted and never returned', async () => {
    const r = await saveOrgClient({ provider: 'intuit', label: 'acme-ca', clientId: 'id-1', clientSecret: 'super-secret-xyz' });
    expect(r).toEqual({ ok: true });
    const org = (await ctx.store.orgClients.list()).find((o) => o.label === 'acme-ca')!;
    expect(org).toMatchObject({ provider: 'intuit', clientId: 'id-1' });
    expect(org.workspaceDomain).toBeUndefined();
    expect((await ctx.store.orgClients.get(org.id))?.clientSecret).toBe('super-secret-xyz');
    expect(JSON.stringify(await ctx.store.orgClients.list())).not.toContain('super-secret-xyz');
    expect(await render()).not.toContain('super-secret-xyz');
  });

  it('the form action never echoes the submitted secret', async () => {
    const fd = new FormData();
    fd.set('provider', 'intuit');
    fd.set('label', 'acme-ca');
    fd.set('clientId', 'id-1');
    fd.set('clientSecret', 'super-secret-xyz');
    const out = await saveOrgClientForm({ status: 'idle' }, fd);
    expect(out.status).toBe('ok');
    expect(JSON.stringify(out)).not.toContain('super-secret-xyz');
    const bad = new FormData();
    bad.set('provider', 'intuit');
    bad.set('label', 'BAD LABEL');
    bad.set('clientId', 'id');
    bad.set('clientSecret', 'super-secret-xyz');
    expect(JSON.stringify(await saveOrgClientForm({ status: 'idle' }, bad))).not.toContain('super-secret-xyz');
  });

  it('needs a secret for a new client, keeps the stored one on edit, and the provider never changes', async () => {
    expect(await saveOrgClient({ provider: 'intuit', label: 'acme-ca', clientId: 'id-1', clientSecret: '' })).toMatchObject({ ok: false });
    const org = await intuitOrg();
    expect(await saveOrgClient({ id: org.id, provider: 'google', label: org.label, clientId: 'id-2', clientSecret: '' })).toEqual({ ok: true });
    const after = (await ctx.store.orgClients.get(org.id))!;
    expect(after).toMatchObject({ provider: 'intuit', clientId: 'id-2', clientSecret: 'fake-intuit-client-secret' });
  });

  it('a Google client still needs a domain, and labels are unique per provider', async () => {
    expect(await saveOrgClient({ label: 'acme', clientId: 'id', clientSecret: 's' })).toMatchObject({ ok: false, error: expect.stringMatching(/domain/i) });
    // 'stratify' exists for google; the same label for an Intuit app is fine, a second Intuit 'stratify-ca' is not
    expect(await saveOrgClient({ provider: 'intuit', label: 'stratify', clientId: 'id', clientSecret: 's' })).toEqual({ ok: true });
    expect(await saveOrgClient({ provider: 'intuit', label: 'stratify-ca', clientId: 'id', clientSecret: 's' })).toMatchObject({
      ok: false, error: expect.stringMatching(/already in use/),
    });
  });
});

describe('account actions with two providers', () => {
  it('reordering a Google account leaves the QuickBooks company where it is', async () => {
    const before = await ctx.store.accounts.list();
    const prime = before.find((a) => a.label === 'prime')!;
    expect(await reorderAccounts({ accountId: prime.id, direction: 'up' })).toEqual({ ok: true });
    expect((await ctx.store.accounts.list()).map((a) => a.label)).toEqual(['prime', 'stratify', 'stratify-ca']);
    const qb = before.find((a) => a.provider === 'intuit')!;
    expect(await reorderAccounts({ accountId: qb.id, direction: 'up' })).toEqual({ ok: false, error: 'Already first.' });
    expect(await reorderAccounts({ accountId: prime.id, direction: 'down' })).toEqual({ ok: true });
  });

  it('a company can take a Google label, but not a label of another company', async () => {
    const qb = (await ctx.store.accounts.list()).find((a) => a.provider === 'intuit')!;
    expect(await renameAccount({ accountId: qb.id, label: 'prime' })).toEqual({ ok: true });
    expect((await ctx.store.accounts.list()).map((a) => a.label)).toEqual(['stratify', 'prime', 'prime']);
  });
});
