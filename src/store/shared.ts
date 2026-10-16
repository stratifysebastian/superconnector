import type { Account, Provider } from '../core/contracts/account';

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const AUDIT_DETAIL_MAX = 200;

export function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error('Invalid label: use 1-32 chars of a-z, 0-9 and "-", starting with a letter or digit');
  }
}

export function isStratify(label: string): boolean {
  return label.toLowerCase() === 'stratify';
}

/** First free label: `base`, then `base-2`, `base-3`, ... (ADR-10). Result always matches LABEL_PATTERN. */
export function uniqueLabel(base: string, taken: Set<string>): string {
  const b = base.toLowerCase();
  assertLabel(b);
  if (!taken.has(b)) return b;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = b.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An Intuit client has no Workspace domain; a Google client must have one. A client's provider never changes. */
export function assertOrgClient(provider: Provider, workspaceDomain: string | undefined, existing: Provider | undefined): void {
  if (provider !== 'google' && provider !== 'intuit') throw new Error('Unsupported org client provider');
  if (existing !== undefined && existing !== provider) throw new Error('Org client provider cannot change');
  if (provider === 'google' && !workspaceDomain) throw new Error('A Google org client needs a workspace domain');
}

/** Intuit accounts need their realmId (the company); other providers must not carry one. */
export function assertConnectInput(a: Pick<Account, 'provider' | 'realmId'>): void {
  if (a.provider === 'intuit' && !a.realmId) throw new Error('An Intuit account needs a realmId');
  if (a.provider !== 'intuit' && a.realmId !== undefined) throw new Error('realmId is only for Intuit accounts');
}

/** Same account on reconnect: Google by email, Intuit by company (realmId). */
export function sameAccount(x: Pick<Account, 'provider' | 'email' | 'realmId'>, a: Pick<Account, 'provider' | 'email' | 'realmId'>): boolean {
  if (x.provider !== a.provider) return false;
  return a.provider === 'intuit' ? x.realmId === a.realmId : x.email === a.email;
}

export function truncateDetail(detail: string | undefined): string | undefined {
  return detail === undefined ? undefined : detail.slice(0, AUDIT_DETAIL_MAX);
}

export function compareAccounts(a: Account, b: Account): number {
  return a.priority - b.priority || Date.parse(a.connectedAt) - Date.parse(b.connectedAt);
}

/** Throws unless `ids` is exactly the set `current` (no duplicates, missing or extra). */
export function assertSameIdSet(ids: string[], current: string[]): void {
  const want = new Set(current);
  if (ids.length !== want.size || new Set(ids).size !== ids.length || !ids.every((i) => want.has(i))) {
    throw new Error('reorder: ids must be exactly the current set of account ids');
  }
}
