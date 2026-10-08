import { ProviderError } from '@/core/errors';

/** True when a Google OAuth token-endpoint error body says the refresh token is dead. */
export function isInvalidGrant(oauthErrorBody: unknown): boolean {
  if (typeof oauthErrorBody === 'string') {
    try {
      return isInvalidGrant(JSON.parse(oauthErrorBody));
    } catch {
      return false;
    }
  }
  return (
    typeof oauthErrorBody === 'object' &&
    oauthErrorBody !== null &&
    (oauthErrorBody as { error?: unknown }).error === 'invalid_grant'
  );
}

/** Failure from the token endpoint. Messages are generic: never the response body or a token. */
export class GoogleAuthError extends Error {
  override readonly name = 'GoogleAuthError';
  constructor(
    readonly kind: 'invalid_grant' | 'other',
    message?: string,
  ) {
    super(
      message ?? (kind === 'invalid_grant' ? 'Google refresh token is no longer valid' : 'Google token request failed'),
    );
  }
}

/** invalid_grant → needs_reconnect; other auth errors → upstream_error. */
export function authErrorToProviderError(err: GoogleAuthError): ProviderError {
  return err.kind === 'invalid_grant'
    ? new ProviderError('needs_reconnect', 'Google account needs to be reconnected')
    : new ProviderError('upstream_error', 'Google token request failed');
}

/** Converts a GoogleAuthError to a ProviderError; anything else is returned unchanged. */
export function mapAuthError(err: unknown): unknown {
  return err instanceof GoogleAuthError ? authErrorToProviderError(err) : err;
}
