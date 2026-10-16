import type { Account, AccountSelector } from './contracts/account';
import { AccountSelectionError } from './errors';

export function byPriority(accounts: Account[]): Account[] {
  return accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.priority - y.a.priority || x.i - y.i)
    .map((x) => x.a);
}

/** Resolve a tool's `account` argument to accounts, in priority order, de-duplicated. */
export function resolveAccounts(selector: AccountSelector, accounts: Account[]): Account[] {
  const ordered = byPriority(accounts);
  const labels = ordered.map((a) => a.label);
  if (selector === undefined) return ordered;
  const entries = Array.isArray(selector) ? selector : [selector];
  if (entries.length === 0) {
    throw new AccountSelectionError(
      `No account given. Connected accounts: ${labels.join(', ') || 'none'}.`,
      labels,
    );
  }
  const picked = new Set<Account>();
  for (const raw of entries) {
    const key = String(raw).trim().toLowerCase();
    if (key === 'all') return ordered;
    const hit = ordered.find((a) => a.label.toLowerCase() === key || a.email.toLowerCase() === key);
    if (!hit) {
      throw new AccountSelectionError(
        `Unknown account "${String(raw)}". Connected accounts: ${labels.join(', ') || 'none'}.`,
        labels,
      );
    }
    picked.add(hit);
  }
  return ordered.filter((a) => picked.has(a));
}
