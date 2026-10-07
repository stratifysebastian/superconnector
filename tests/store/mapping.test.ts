import { describe, expect, it } from 'vitest';
import { accountFromRow, accountToInsertRow, isoToMs, msToIso } from '../../src/store/mapping';
import { assertLabel, assertSameIdSet, uniqueLabel } from '../../src/store/shared';

describe('row mapping', () => {
  it('maps snake_case rows to Account', () => {
    const a = accountFromRow({
      id: 'i',
      provider: 'google',
      email: 'e@x.test',
      label: 'prime',
      org_client_id: 'o',
      priority: 2,
      connected_at: '2026-10-07T10:00:00+00:00',
      status: 'needs_reconnect',
      granted_scopes: null,
    });
    expect(a).toEqual({
      id: 'i',
      provider: 'google',
      email: 'e@x.test',
      label: 'prime',
      orgClientId: 'o',
      priority: 2,
      connectedAt: '2026-10-07T10:00:00.000Z',
      status: 'needs_reconnect',
      grantedScopes: [],
    });
  });

  it('maps Account fields to an insert row', () => {
    expect(
      accountToInsertRow({ provider: 'google', email: 'e', label: 'l', orgClientId: 'o', priority: 1, status: 'active', grantedScopes: ['s'] }),
    ).toEqual({ provider: 'google', email: 'e', label: 'l', org_client_id: 'o', priority: 1, status: 'active', granted_scopes: ['s'] });
  });

  it('converts timestamps both ways', () => {
    expect(isoToMs(msToIso(1_700_000_000_123))).toBe(1_700_000_000_123);
  });
});

describe('shared helpers', () => {
  it('uniqueLabel suffixes and stays within 32 chars', () => {
    expect(uniqueLabel('Prime', new Set())).toBe('prime');
    expect(uniqueLabel('prime', new Set(['prime', 'prime-2']))).toBe('prime-3');
    const long = 'a'.repeat(32);
    const got = uniqueLabel(long, new Set([long]));
    expect(got).toHaveLength(32);
    expect(got.endsWith('-2')).toBe(true);
    expect(() => assertLabel(got)).not.toThrow();
  });
  it('assertSameIdSet', () => {
    expect(() => assertSameIdSet(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(() => assertSameIdSet(['a'], ['a', 'b'])).toThrow();
    expect(() => assertSameIdSet(['a', 'a'], ['a', 'b'])).toThrow();
  });
});
