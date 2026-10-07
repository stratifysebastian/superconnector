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
import { parseFlash } from '@/app/connect/logic';
import ConnectPage from '@/app/connect/page';

const SESSION = { email: 'admin@stratify.example', expiresAt: Date.now() + 60_000 };
let ctx: ServerContext;

async function labels() {
  return (await ctx.store.accounts.list()).map((a) => a.label);
}

beforeEach(async () => {
  const store = createMemoryStore(createCipher(Buffer.alloc(32, 9).toString('base64')));
  ctx = await createServerContext({
    env: parseEnv({ GOOGLE_MODE: 'mock' }),
    store,
    log: { info() {}, warn() {}, error() {} },
  });
  state.ctx = ctx;
  state.session = SESSION;
});

describe('without a session', () => {
  beforeEach(() => {
    state.session = null;
  });

  it('rejects every action and changes nothing', async () => {
    const [stratify, prime] = await ctx.store.accounts.list();
    const org = (await ctx.store.orgClients.list())[0]!;
    const r1 = await reorderAccounts({ accountId: prime!.id, direction: 'up' });
    const r2 = await renameAccount({ accountId: stratify!.id, label: 'hacked' });
    const r3 = await saveOrgClient({
      id: org.id, label: 'hacked', workspaceDomain: 'x.example', clientId: 'c', clientSecret: 's',
    });
    for (const r of [r1, r2, r3]) expect(r).toEqual({ ok: false, error: expect.stringMatching(/unauthorised/i) });
    expect(await labels()).toEqual(['stratify', 'prime']);
    expect((await ctx.store.orgClients.get(org.id))?.label).toBe(org.label);
  });

  it('page redirects to sign-in', async () => {
    await expect(ConnectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/signin?next=/connect',
    );
  });
});

describe('reorderAccounts', () => {
  it('moves prime up so it is first and persists', async () => {
    const prime = (await ctx.store.accounts.list())[1]!;
    expect(await reorderAccounts({ accountId: prime.id, direction: 'up' })).toEqual({ ok: true });
    expect(await labels()).toEqual(['prime', 'stratify']);
  });

  it('errors when moving the first account up or the last down', async () => {
    const [first, last] = await ctx.store.accounts.list();
    expect((await reorderAccounts({ accountId: first!.id, direction: 'up' })).ok).toBe(false);
    expect((await reorderAccounts({ accountId: last!.id, direction: 'down' })).ok).toBe(false);
    expect(await labels()).toEqual(['stratify', 'prime']);
  });

  it('errors on an unknown account', async () => {
    expect((await reorderAccounts({ accountId: 'nope', direction: 'up' })).ok).toBe(false);
  });
});

describe('renameAccount', () => {
  it('rejects bad patterns', async () => {
    const a = (await ctx.store.accounts.list())[0]!;
    for (const label of ['', 'Bad Label', '-lead', 'UPPER', 'a'.repeat(33), '<script>']) {
      const r = await renameAccount({ accountId: a.id, label });
      expect(r.ok).toBe(false);
    }
    expect(await labels()).toEqual(['stratify', 'prime']);
  });

  it('rejects a duplicate label with an inline-friendly message', async () => {
    const a = (await ctx.store.accounts.list())[0]!;
    expect(await renameAccount({ accountId: a.id, label: 'prime' })).toEqual({
      ok: false,
      error: 'That label is already in use.',
    });
  });

  it('persists a valid rename', async () => {
    const a = (await ctx.store.accounts.list())[1]!;
    expect(await renameAccount({ accountId: a.id, label: 'pr1me-2' })).toEqual({ ok: true });
    expect(await labels()).toEqual(['stratify', 'pr1me-2']);
  });
});

describe('saveOrgClient', () => {
  it('creates a new client', async () => {
    const r = await saveOrgClient({
      label: 'acme', workspaceDomain: 'Acme.Example', clientId: 'fake-id-acme', clientSecret: 'fake-secret-acme',
    });
    expect(r).toEqual({ ok: true });
    const created = (await ctx.store.orgClients.list()).find((o) => o.label === 'acme')!;
    expect(created.workspaceDomain).toBe('acme.example');
    expect((await ctx.store.orgClients.get(created.id))?.clientSecret).toBe('fake-secret-acme');
  });

  it('requires a secret for a new client, and validates label and domain', async () => {
    const base = { label: 'acme', workspaceDomain: 'acme.example', clientId: 'id', clientSecret: 's' };
    expect((await saveOrgClient({ ...base, clientSecret: '' })).ok).toBe(false);
    expect((await saveOrgClient({ ...base, label: 'Bad Label' })).ok).toBe(false);
    expect((await saveOrgClient({ ...base, workspaceDomain: 'not a domain' })).ok).toBe(false);
    expect((await saveOrgClient({ ...base, clientId: ' ' })).ok).toBe(false);
  });

  it('keeps the old secret when updating with an empty secret', async () => {
    const org = (await ctx.store.orgClients.list()).find((o) => o.label === 'prime')!;
    const r = await saveOrgClient({
      id: org.id, label: 'prime', workspaceDomain: 'prime2.example', clientId: 'fake-id-new', clientSecret: '',
    });
    expect(r).toEqual({ ok: true });
    const after = (await ctx.store.orgClients.get(org.id))!;
    expect(after.clientSecret).toBe('fake-client-secret-prime');
    expect(after.clientId).toBe('fake-id-new');
    expect(after.workspaceDomain).toBe('prime2.example');
  });

  it('replaces the secret when one is supplied', async () => {
    const org = (await ctx.store.orgClients.list())[0]!;
    await saveOrgClient({
      id: org.id, label: org.label, workspaceDomain: org.workspaceDomain, clientId: org.clientId, clientSecret: 'rotated',
    });
    expect((await ctx.store.orgClients.get(org.id))?.clientSecret).toBe('rotated');
  });

  it('rejects a duplicate label', async () => {
    const r = await saveOrgClient({
      label: 'prime', workspaceDomain: 'dup.example', clientId: 'id', clientSecret: 's',
    });
    expect(r).toEqual({ ok: false, error: 'That org client label is already in use.' });
    expect((await ctx.store.orgClients.list()).length).toBe(2);
  });

  it('rejects an unknown id', async () => {
    const r = await saveOrgClient({
      id: 'missing', label: 'x', workspaceDomain: 'x.example', clientId: 'i', clientSecret: '',
    });
    expect(r.ok).toBe(false);
  });
});

describe('parseFlash', () => {
  it('maps known codes and a valid label', () => {
    const f = parseFlash({ connected: 'prime', missing: 'gmail,drive,bogus', error: 'wrong_account' });
    expect(f.map((x) => x.kind)).toEqual(['success', 'warning', 'error']);
    expect(f[1]!.text).toContain('gmail, drive');
    expect(f[1]!.text).not.toContain('bogus');
  });

  it('ignores bad labels and unknown products', () => {
    expect(parseFlash({ connected: '<b>x</b>', missing: 'evil' })).toEqual([]);
  });
});

describe('page rendering', () => {
  async function render(params: Record<string, string> = {}) {
    return renderToString(await ConnectPage({ searchParams: Promise.resolve(params) }));
  }

  it('shows accounts in order, redirect URI, and never any secret', async () => {
    const html = await render();
    expect(html).not.toContain('fake-client-secret');
    expect(html).toContain('http://localhost:3000/api/google/callback');
    expect(html.indexOf('seb@stratify.example')).toBeGreaterThan(-1);
    expect(html.indexOf('seb@stratify.example')).toBeLessThan(html.indexOf('seb@prime.example'));
    expect(html).toContain('Signed in as admin@stratify.example');
    expect(html).toContain('/api/auth/signout');
    expect(html).toContain('aria-label="Move prime up"');
    expect(html).toContain('type="password"');
    expect(html).toContain('fake-client-id-prime'); // client ID is fine to show
    expect(html).toContain('scope="col"');
    expect(html).toContain('<caption');
    expect(html).toContain('role="status"');
  });

  it('flags needs-reconnect accounts and missing products', async () => {
    const prime = (await ctx.store.accounts.list())[1]!;
    await ctx.store.accounts.setStatus(prime.id, 'needs_reconnect');
    await ctx.store.accounts.upsertOnConnect({
      provider: 'google', email: 'x@acme.example', label: 'acme', orgClientId: prime.orgClientId,
      grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar'],
    });
    const html = await render();
    expect(html).toContain('Needs reconnect');
    expect(html).toContain('gmail (missing)');
    expect(html).toContain(`/api/google/connect?org=${prime.orgClientId}&amp;account=${prime.id}`);
  });

  it('does not echo unknown query text', async () => {
    const html = await render({ error: '<script>alert(1)</script>', connected: '<script>x</script>', missing: '<img>' });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<img>');
    expect(html).toContain('Something went wrong while connecting');
  });
});
