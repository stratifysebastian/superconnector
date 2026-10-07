import type { Account } from '../core/contracts/account';

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
