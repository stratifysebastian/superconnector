// STUB owned by T0.5 (Google connect + token manager). Signature is fixed; T0.5 replaces the body.
import type { Account } from '@/core/contracts/account';
import type { Store } from '@/core/contracts/store';
import type { Logger } from '@/core/contracts/tool';

export interface TokenManager {
  /**
   * Returns a valid access token for the account: cached if fresh, otherwise refreshed with the
   * stored refresh token via the account's org client. On invalid_grant it marks the account
   * `needs_reconnect` and throws ProviderError('needs_reconnect').
   */
  getAccessToken(account: Account): Promise<string>;
}

export interface TokenManagerDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  void deps;
  return {
    async getAccessToken() {
      throw new Error('createTokenManager: not implemented yet (T0.5)');
    },
  };
}
