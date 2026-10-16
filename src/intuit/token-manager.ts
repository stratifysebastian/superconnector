import type { Account } from '@/core/contracts/account';
import type { Store } from '@/core/contracts/store';
import type { Logger } from '@/core/contracts/tool';
import { ProviderError } from '@/core/errors';
import { isInvalidGrant } from '@/google/errors';
import type { TokenManager } from '@/google/token-manager';
import { postIntuitToken, IntuitOAuthError, type IntuitTokenResponse } from './oauth';

export interface IntuitTokenManagerDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

const FRESH_MARGIN_MS = 60_000;

/**
 * Same shape as the Google token manager, with one difference that matters: Intuit ROTATES the refresh token.
 * Every refresh saves the refresh token Intuit returns, with compare-and-set so two concurrent refreshes
 * (this process via the in-flight map, other instances via the store) cannot overwrite each other.
 */
export function createIntuitTokenManager(deps: IntuitTokenManagerDeps): TokenManager {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, Promise<string>>();

  async function needsReconnect(account: Account, why: string): Promise<never> {
    await store.accounts.setStatus(account.id, 'needs_reconnect');
    await store.audit.write({ tool: 'token_refresh', account: account.label, outcome: 'error', detail: why });
    log?.warn({ msg: 'account needs reconnect', account: account.label, outcome: 'needs_reconnect' });
    throw new ProviderError(
      'needs_reconnect',
      `${account.label.toUpperCase()} account disconnected — reconnect at /connect`,
    );
  }

  const upstream = (status?: number) => new ProviderError('upstream_error', 'Intuit token request failed', status);

  async function refresh(account: Account, retriedAfterRace = false): Promise<string> {
    if (account.provider !== 'intuit') throw upstream();
    const used = await store.tokens.getRefreshToken(account.id);
    if (!used) return needsReconnect(account, 'no refresh token stored');
    const org = await store.orgClients.get(account.orgClientId);
    if (!org || org.provider !== 'intuit') throw upstream();

    let res: { ok: boolean; status: number; body: unknown };
    try {
      res = await postIntuitToken({
        client: org,
        form: { grant_type: 'refresh_token', refresh_token: used },
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (e) {
      if (!(e instanceof IntuitOAuthError)) throw e;
      log?.error({ msg: 'token refresh network error', account: account.label, outcome: 'error' });
      throw upstream();
    }

    if (!res.ok) {
      if (isInvalidGrant(res.body)) {
        // Another instance may have rotated the token after we read it. If the stored one changed, use it once.
        const current = await store.tokens.getRefreshToken(account.id);
        if (current && current !== used && !retriedAfterRace) return refresh(account, true);
        return needsReconnect(account, 'invalid_grant');
      }
      log?.error({ msg: 'token refresh failed', account: account.label, outcome: 'error', status: res.status });
      throw upstream(res.status);
    }
    const t = res.body as IntuitTokenResponse | undefined;
    if (!t || typeof t.access_token !== 'string' || typeof t.expires_in !== 'number') throw upstream();

    // Always keep the refresh token Intuit returned. If it omits one, the old one stays valid.
    const next = typeof t.refresh_token === 'string' && t.refresh_token !== '' ? t.refresh_token : used;
    if (next !== used) {
      const swapped = await store.tokens.swapRefreshToken(account.id, used, next);
      if (!swapped) {
        // Someone else saved a newer token first. Keep theirs; our access token is still good for this call.
        log?.warn({ msg: 'refresh token rotation lost a race', account: account.label, outcome: 'race' });
      }
    }
    await store.tokens.setCachedAccess(account.id, t.access_token, now() + t.expires_in * 1000);
    return t.access_token;
  }

  return {
    async getAccessToken(account, opts) {
      if (!opts?.forceRefresh) {
        const cached = await store.tokens.getCachedAccess(account.id);
        if (cached && cached.expiresAt - now() > FRESH_MARGIN_MS) return cached.token;
      }
      const existing = inflight.get(account.id);
      if (existing) return existing;
      const p = refresh(account).finally(() => inflight.delete(account.id));
      inflight.set(account.id, p);
      return p;
    },
  };
}
