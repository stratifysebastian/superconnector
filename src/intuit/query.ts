/**
 * QuickBooks query text (`select ... from Entity where ...`) is built here, from our own fragments and escaped values.
 * No tool accepts a raw query, and the endpoint rule only lets a `select` on Item, Customer or Account through.
 */
import type { QbItemType } from '@/core/contracts/quickbooks';

/**
 * A quoted QBO string literal. Backslash and single quote are escaped; control characters are dropped, so a value
 * cannot close the literal or start a new clause. `%` is dropped too, because it is LIKE's wildcard.
 */
export function qboString(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `'${clean.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export const PAGE = 1000;
const TYPES: readonly QbItemType[] = ['Service', 'Inventory', 'NonInventory'];

export function itemsQuery(f: { type?: QbItemType; nameContains?: string; start?: number; max?: number }): string {
  if (f.type !== undefined && !TYPES.includes(f.type)) throw new Error('Unknown item type');
  const where = ['Active = true', ...(f.type ? [`Type = '${f.type}'`] : []), ...(f.nameContains ? [`Name like ${likeLiteral(f.nameContains)}`] : [])];
  return `select * from Item where ${where.join(' and ')} startposition ${f.start ?? 1} maxresults ${f.max ?? PAGE}`;
}

export function customersQuery(f: { nameContains?: string; email?: string; max?: number }): string {
  const where = [
    'Active = true',
    ...(f.nameContains ? [`DisplayName like ${likeLiteral(f.nameContains)}`] : []),
    ...(f.email ? [`PrimaryEmailAddr = ${qboString(f.email)}`] : []),
  ];
  return `select * from Customer where ${where.join(' and ')} maxresults ${f.max ?? 20}`;
}

export const accountsQuery = (type: 'Income' | 'Cost of Goods Sold' | 'Other Current Asset'): string =>
  `select Id, Name, AccountType, AccountSubType from Account where Active = true and AccountType = ${qboString(type)} maxresults 100`;

/** '%term%' as one escaped literal. */
function likeLiteral(term: string): string {
  const inner = qboString(term);
  return `'%${inner.slice(1)}`.replace(/'$/, "%'");
}
