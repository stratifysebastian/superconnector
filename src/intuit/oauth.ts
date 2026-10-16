// Intuit OAuth helpers for the connect flow. Pure: every dependency is passed in.
// Together with token-manager.ts this is the only code that calls Intuit's token endpoint.
import type { OrgClient, Store } from '@/core/contracts/store';
import { QUICKBOOKS_SCOPE } from '@/core/products';
import { hashToken, randomToken } from '@/lib/crypto';

export const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Reason is plain language; never contains tokens, codes, secrets or the response body. */
export class IntuitOAuthError extends Error {
  override readonly name = 'IntuitOAuthError';
  constructor(
    readonly reason: string,
    readonly kind: 'exchange_failed' = 'exchange_failed',
  ) {
    super(reason);
  }
}

export function buildIntuitAuthUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    scope: QUICKBOOKS_SCOPE,
    redirect_uri: p.redirectUri,
    state: p.state,
  });
  return `${INTUIT_AUTH_URL}?${q.toString()}`;
}

/** Creates a state, stores only its hash (10 minutes, single use), and returns the Intuit URL to redirect to. */
export async function startIntuitAuth(p: {
  store: Store;
  orgClientId: string;
  orgClient: Pick<OrgClient, 'clientId'>;
  accountId?: string;
  redirectUri: string;
  now?: () => number;
}): Promise<string> {
  const state = randomToken();
  await p.store.oauth.saveState(hashToken(state), {
    orgClientId: p.orgClientId,
    ...(p.accountId ? { accountId: p.accountId } : {}),
    expiresAt: (p.now ?? Date.now)() + STATE_TTL_MS,
  });
  return buildIntuitAuthUrl({ clientId: p.orgClient.clientId, redirectUri: p.redirectUri, state });
}

export interface IntuitTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** POSTs to the token endpoint with Basic client auth. Returns the status and parsed body (undefined if not JSON). */
export async function postIntuitToken(p: {
  client: Pick<OrgClient, 'clientId' | 'clientSecret'>;
  form: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const basic = Buffer.from(`${p.client.clientId}:${p.client.clientSecret}`, 'utf8').toString('base64');
  let res: Response;
  try {
    res = await (p.fetchImpl ?? fetch)(INTUIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(p.form).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    throw new IntuitOAuthError('Could not reach the Intuit token endpoint');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, body };
}

export interface IntuitTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function exchangeIntuitCode(p: {
  client: Pick<OrgClient, 'clientId' | 'clientSecret'>;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<IntuitTokens> {
  const r = await postIntuitToken({
    client: p.client,
    form: { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri },
    ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
  });
  if (!r.ok) throw new IntuitOAuthError(`Intuit rejected the authorization code (HTTP ${r.status})`);
  const t = r.body as IntuitTokenResponse | undefined;
  if (
    !t ||
    typeof t.access_token !== 'string' ||
    typeof t.refresh_token !== 'string' ||
    t.refresh_token === '' ||
    typeof t.expires_in !== 'number'
  ) {
    throw new IntuitOAuthError('Intuit token response was malformed');
  }
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
}
