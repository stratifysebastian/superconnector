import type { Account } from '@/core/contracts/account';
import type { Store } from '@/core/contracts/store';
import type { Logger } from '@/core/contracts/tool';
import { ProviderError } from '@/core/errors';
import { isInvalidGrant } from '@/google/errors';
import { GOOGLE_TOKEN_URL } from '@/google/oauth';

export interface TokenManager {
  /**
   * Returns a valid access token for the account: cached if fresh, otherwise refreshed with the
   * stored refresh token via the account's org client. On invalid_grant it marks the account
   * `needs_reconnect` and throws ProviderError('needs_reconnect').
   * `forceRefresh` skips the cache (still joining any in-flight refresh for the account).
   */
  getAccessToken(account: Account, opts?: { forceRefresh?: boolean }): Promise<string>;
}

export interface TokenManagerDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

const FRESH_MARGIN_MS = 60_000;

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
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

  async function refresh(account: Account): Promise<string> {
    const refreshToken = await store.tokens.getRefreshToken(account.id);
    if (!refreshToken) return needsReconnect(account, 'no refresh token stored');
    const org = await store.orgClients.get(account.orgClientId);
    if (!org) throw new ProviderError('upstream_error', 'Google token request failed');

    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: org.clientId,
          client_secret: org.clientSecret,
        }).toString(),
      });
    } catch {
      log?.error({ msg: 'token refresh network error', account: account.label, outcome: 'error' });
      throw new ProviderError('upstream_error', 'Google token request failed');
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      if (isInvalidGrant(body)) return needsReconnect(account, 'invalid_grant');
      log?.error({ msg: 'token refresh failed', account: account.label, outcome: 'error', status: res.status });
      throw new ProviderError('upstream_error', 'Google token request failed', res.status);
    }
    const t = body as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (!t || typeof t.access_token !== 'string' || typeof t.expires_in !== 'number') {
      throw new ProviderError('upstream_error', 'Google token request failed');
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
