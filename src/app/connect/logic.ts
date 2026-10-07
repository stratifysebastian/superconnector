// Testable /connect logic: (ctx, session, input) -> result. No Next.js imports here.
import type { Account, Product } from '@/core/contracts/account';
import { PRODUCTS, grantedProducts, missingProducts } from '@/core/products';
import type { ServerContext } from '@/server/context';

export interface Session {
  email: string;
  expiresAt: number;
}
export type Result = { ok: true } | { ok: false; error: string };

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const UNAUTHORISED: Result = { ok: false, error: 'Unauthorised: sign in again.' };
const fail = (error: string): Result => ({ ok: false, error });

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
  const ids = (await ctx.store.accounts.list()).map((a) => a.id);
  const i = ids.indexOf(input.accountId);
  if (i < 0) return fail('Account not found.');
  const j = input.direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) {
    return fail(input.direction === 'up' ? 'Already first.' : 'Already last.');
  }
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
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

export interface OrgClientInput {
  id?: string;
  label: string;
  workspaceDomain: string;
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
  const workspaceDomain = input.workspaceDomain.trim().toLowerCase();
  const clientId = input.clientId.trim();
  let clientSecret = input.clientSecret.trim();
  if (!isValidLabel(label)) return fail(`Invalid label. ${LABEL_RULE}`);
  if (!DOMAIN_PATTERN.test(workspaceDomain)) return fail('Enter a Workspace domain such as example.com.');
  if (!clientId) return fail('Client ID is required.');

  const id = input.id?.trim() || undefined;
  if (id) {
    const existing = await ctx.store.orgClients.get(id);
    if (!existing) return fail('Org client not found.');
    // Keep the stored secret when none is supplied; it never leaves the server.
    if (!clientSecret) clientSecret = existing.clientSecret;
  } else if (!clientSecret) {
    return fail('Client secret is required for a new org client.');
  }
  try {
    await ctx.store.orgClients.upsert({ ...(id ? { id } : {}), label, workspaceDomain, clientId, clientSecret });
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
export interface ConnectData {
  email: string;
  redirectUri: string;
  accounts: AccountView[];
  orgClients: OrgClientView[];
}

export async function loadConnectData(ctx: ServerContext, session: Session): Promise<ConnectData> {
  const [accounts, orgClients] = await Promise.all([ctx.store.accounts.list(), ctx.store.orgClients.list()]);
  return {
    email: session.email,
    redirectUri: `${ctx.baseUrl}/api/google/callback`,
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
      workspaceDomain: o.workspaceDomain,
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
  denied: 'Access was declined in Google, so nothing was connected.',
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
