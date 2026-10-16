// Testable /connect logic: (ctx, session, input) -> result. No Next.js imports here.
import type { Account, Product, Provider } from '@/core/contracts/account';
import { PRODUCTS, grantedProducts, missingProducts } from '@/core/products';
import type { ServerContext } from '@/server/context';

export interface Session {
  email: string;
  expiresAt: number;
}
export type Result = { ok: true } | { ok: false; error: string };

export type RevokeResult = { ok: true; count: number } | { ok: false; error: string };

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const UNAUTHORISED = { ok: false as const, error: 'Unauthorised: sign in again.' };
const fail = (error: string) => ({ ok: false as const, error });

export function isValidLabel(s: string): boolean {
  return LABEL_PATTERN.test(s);
}

const LABEL_RULE = 'Use 1-32 characters: lowercase letters, digits and "-", starting with a letter or digit.';

export async function reorderAccounts(
  ctx: ServerContext,
  session: Session | null,
  input: { accountId: string; direction: 'up' | 'down' },
): Promise<Result> {
  if (!session) return UNAUTHORISED;
  if (input.direction !== 'up' && input.direction !== 'down') return fail('Unknown direction.');
  const all = await ctx.store.accounts.list();
  const target = all.find((a) => a.id === input.accountId);
  if (!target) return fail('Account not found.');
  // Order is per provider: swap within the account's own provider and leave the other provider's slots alone.
  const slots = all.map((a, k) => (a.provider === target.provider ? k : -1)).filter((k) => k >= 0);
  const mine = slots.map((k) => all[k]!.id);
  const i = mine.indexOf(input.accountId);
  const j = input.direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= mine.length) {
    return fail(input.direction === 'up' ? 'Already first.' : 'Already last.');
  }
  [mine[i], mine[j]] = [mine[j]!, mine[i]!];
  const ids = all.map((a) => a.id);
  slots.forEach((k, n) => {
    ids[k] = mine[n]!;
  });
  try {
    await ctx.store.accounts.reorder(ids);
  } catch {
    return fail('Could not reorder accounts.');
  }
  return { ok: true };
}

export async function renameAccount(
  ctx: ServerContext,
  session: Session | null,
  input: { accountId: string; label: string },
): Promise<Result> {
  if (!session) return UNAUTHORISED;
  const label = input.label.trim();
  if (!isValidLabel(label)) return fail(`Invalid label. ${LABEL_RULE}`);
  try {
    await ctx.store.accounts.setLabel(input.accountId, label);
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (/in use/i.test(m)) return fail('That label is already in use.');
    if (/not found/i.test(m)) return fail('Account not found.');
    return fail('Could not rename the account.');
  }
  return { ok: true };
}

/** Kill switch: revokes every token issued to MCP clients. Requires the explicit confirmation. */
export async function revokeAllAccess(
  ctx: ServerContext,
  session: Session | null,
  input: { confirmed: boolean },
): Promise<RevokeResult> {
  if (!session) return UNAUTHORISED;
  if (!input.confirmed) return fail('Tick the confirmation box to revoke all Claude access.');
  let count: number;
  try {
    count = await ctx.store.oauth.revokeAllTokens();
  } catch {
    try {
      await ctx.store.audit.write({ tool: 'revoke_all', account: 'all', outcome: 'error' });
    } catch {
      // best effort
    }
    return fail('Could not revoke tokens.');
  }
  try {
    await ctx.store.audit.write({ tool: 'revoke_all', account: 'all', outcome: 'ok', detail: `revoked ${count}` });
  } catch {
    // the revoke already happened; do not report failure
  }
  return { ok: true, count };
}

export interface OrgClientInput {
  id?: string;
  /** New clients only; an existing client keeps its provider. Default 'google'. */
  provider?: 'google' | 'intuit';
  label: string;
  workspaceDomain?: string;
  clientId: string;
  clientSecret: string;
}

export async function saveOrgClient(
  ctx: ServerContext,
  session: Session | null,
  input: OrgClientInput,
): Promise<Result> {
  if (!session) return UNAUTHORISED;
  const label = input.label.trim();
  const workspaceDomain = (input.workspaceDomain ?? '').trim().toLowerCase();
  const clientId = input.clientId.trim();
  let clientSecret = input.clientSecret.trim();
  if (!isValidLabel(label)) return fail(`Invalid label. ${LABEL_RULE}`);
  if (!clientId) return fail('Client ID is required.');

  const id = input.id?.trim() || undefined;
  const existing = id ? await ctx.store.orgClients.get(id) : null;
  if (id && !existing) return fail('Org client not found.');
  const provider = existing?.provider ?? (input.provider === 'intuit' ? 'intuit' : 'google');
  if (provider === 'google' && !DOMAIN_PATTERN.test(workspaceDomain)) return fail('Enter a Workspace domain such as example.com.');
  if (id && existing) {
    // Keep the stored secret when none is supplied; it never leaves the server.
    if (!clientSecret) clientSecret = existing.clientSecret;
  } else if (!clientSecret) {
    return fail('Client secret is required for a new org client.');
  }
  try {
    await ctx.store.orgClients.upsert({
      ...(id ? { id } : {}),
      provider,
      label,
      ...(provider === 'google' ? { workspaceDomain } : {}),
      clientId,
      clientSecret,
    });
  } catch (e) {
    if (e instanceof Error && /label/i.test(e.message) && /in use/i.test(e.message)) {
      return fail('That org client label is already in use.');
    }
    return fail('Could not save the org client.');
  }
  return { ok: true };
}

// ---- Page data and flash messages ----

export interface AccountView {
  id: string;
  priority: number;
  label: string;
  email: string;
  status: Account['status'];
  orgClientId: string;
  granted: Product[];
  missing: Product[];
}
export interface OrgClientView {
  id: string;
  label: string;
  clientId: string;
  workspaceDomain: string;
}
export interface QuickBooksAccountView {
  id: string;
  label: string;
  companyName: string;
  /** Masked: only the last 4 characters are shown. */
  realmMasked: string;
  status: Account['status'];
  orgClientId: string;
}
export interface QuickBooksClientView {
  id: string;
  label: string;
  clientId: string;
}
export interface ConnectData {
  email: string;
  redirectUri: string;
  accounts: AccountView[];
  orgClients: OrgClientView[];
  quickbooks: { redirectUri: string; accounts: QuickBooksAccountView[]; clients: QuickBooksClientView[] };
}

/** Everything but the last 4 characters becomes `*`; a short id is fully masked. */
export function maskRealm(realmId: string): string {
  return realmId.length <= 4 ? '*'.repeat(realmId.length) : '*'.repeat(realmId.length - 4) + realmId.slice(-4);
}

const providerOf = <T extends { provider: Provider }>(rows: T[], p: Provider): T[] => rows.filter((r) => r.provider === p);

export async function loadConnectData(ctx: ServerContext, session: Session): Promise<ConnectData> {
  const [allAccounts, allClients] = await Promise.all([ctx.store.accounts.list(), ctx.store.orgClients.list()]);
  const accounts = providerOf(allAccounts, 'google');
  const orgClients = providerOf(allClients, 'google');
  return {
    email: session.email,
    redirectUri: `${ctx.baseUrl}/api/google/callback`,
    quickbooks: {
      redirectUri: `${ctx.baseUrl}/api/intuit/callback`,
      accounts: providerOf(allAccounts, 'intuit').map((a) => ({
        id: a.id,
        label: a.label,
        companyName: a.companyName ?? '(name not available)',
        realmMasked: maskRealm(a.realmId ?? ''),
        status: a.status,
        orgClientId: a.orgClientId,
      })),
      // Explicitly pick fields so a secret can never ride along.
      clients: providerOf(allClients, 'intuit').map((o) => ({ id: o.id, label: o.label, clientId: o.clientId })),
    },
    accounts: accounts.map((a, i) => ({
      id: a.id,
      priority: i + 1,
      label: a.label,
      email: a.email,
      status: a.status,
      orgClientId: a.orgClientId,
      granted: grantedProducts(a.grantedScopes),
      missing: missingProducts(a.grantedScopes),
    })),
    // Explicitly pick fields so a secret can never ride along.
    orgClients: orgClients.map((o) => ({
      id: o.id,
      label: o.label,
      clientId: o.clientId,
      workspaceDomain: o.workspaceDomain ?? '',
    })),
  };
}

export interface Flash {
  kind: 'success' | 'warning' | 'error';
  text: string;
}

const ERROR_TEXT: Record<string, string> = {
  state: 'The sign-in attempt expired or did not match. Please try connecting again.',
  wrong_account:
    'You signed in with a different Google account than the one being reconnected. Try again with the right one.',
  no_refresh_token:
    'Google did not return a refresh token. Remove this app from your Google account permissions, then connect again.',
  denied: 'Access was declined, so nothing was connected.',
  wrong_company:
    'You connected a different QuickBooks company than the one being reconnected. Try again and choose the same company.',
  no_realm: 'QuickBooks did not say which company was connected. Please try again.',
  company_info: 'Connected to QuickBooks but could not read the company details, so nothing was saved. Please try again.',
};
const UNKNOWN_ERROR = 'Something went wrong while connecting. Please try again.';

type Param = string | string[] | undefined;
const first = (p: Param): string | undefined => (Array.isArray(p) ? p[0] : p);

/** Only known codes, known products and a label-shaped value are ever shown. Nothing else is echoed. */
export function parseFlash(params: Record<string, Param>): Flash[] {
  const out: Flash[] = [];
  const connected = first(params.connected);
  if (connected !== undefined && isValidLabel(connected)) {
    out.push({ kind: 'success', text: `Connected account "${connected}".` });
  }
  const missingRaw = first(params.missing);
  if (missingRaw !== undefined) {
    const known = missingRaw.split(',').filter((p): p is Product => (PRODUCTS as string[]).includes(p));
    if (known.length > 0) {
      out.push({
        kind: 'warning',
        text: `Some access was not granted: ${known.join(', ')}. Use Reconnect and tick every box.`,
      });
    }
  }
  const err = first(params.error);
  if (err !== undefined) {
    out.push({ kind: 'error', text: Object.hasOwn(ERROR_TEXT, err) ? ERROR_TEXT[err]! : UNKNOWN_ERROR });
  }
  return out;
}
