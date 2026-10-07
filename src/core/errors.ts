import type { AccountErrorKind } from './contracts/account';

/**
 * Shared runtime error types. Messages must never contain tokens, secrets,
 * message bodies or file contents.
 */

/** A provider call for one account failed in a way the fan-out engine reports per account. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly kind: AccountErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The account argument could not be resolved (unknown label, or a write without exactly one account). */
export class AccountSelectionError extends Error {
  override readonly name = 'AccountSelectionError';
  constructor(
    message: string,
    readonly validLabels: string[],
  ) {
    super(message);
  }
}

/** A write guardrail blocked the call (attendees on an event, update on a guest event, TRASH label, ...). */
export class GuardrailError extends Error {
  override readonly name = 'GuardrailError';
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}
