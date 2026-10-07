import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../../supabase/migrations/0001_init.sql'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

const tables = [...sql.matchAll(/create table\s+(?:if not exists\s+)?(\w+)\s*\(/gi)].map((m) => m[1]!);

/** Body of each create table statement, split into top-level comma separated definitions. */
function columns(table: string): string[] {
  const start = sql.search(new RegExp(`create table\\s+(?:if not exists\\s+)?${table}\\s*\\(`, 'i'));
  const open = sql.indexOf('(', start);
  let depth = 0;
  let i = open;
  const parts: string[] = [];
  let cur = '';
  for (; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) break;
    if (ch === ',' && depth === 1) {
      parts.push(cur.trim());
      cur = '';
    } else if (!(depth === 1 && i === open)) cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

describe('0001_init.sql', () => {
  it('creates the expected tables', () => {
    expect(tables.sort()).toEqual(
      ['account_tokens', 'accounts', 'audit_log', 'google_org_clients', 'oauth_clients', 'oauth_codes', 'oauth_state', 'oauth_tokens'].sort(),
    );
  });

  it.each(tables)('%s has RLS enabled and anon/authenticated revoked', (t) => {
    expect(sql).toMatch(new RegExp(`alter table\\s+${t}\\s+enable row level security\\s*;`, 'i'));
    expect(sql).toMatch(new RegExp(`revoke all on table\\s+${t}\\s+from\\s+anon\\s*,\\s*authenticated\\s*;`, 'i'));
  });

  it('has no policies and no grants', () => {
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
  });

  it('every secret-like column is *_enc or *_hash', () => {
    const offenders: string[] = [];
    for (const t of tables) {
      for (const def of columns(t)) {
        const name = def.split(/\s+/)[0]!.toLowerCase();
        if (['unique', 'primary', 'check', 'constraint', 'foreign'].includes(name)) continue;
        if (/(secret|token|refresh)/.test(name) && !/(_enc|_hash)$/.test(name)) offenders.push(`${t}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares unique constraints and indexes that the store relies on', () => {
    expect(sql).toMatch(/label text not null unique/i);
    expect(sql).toMatch(/unique \(provider, email\)/i);
    for (const [tbl, col] of [
      ['oauth_codes', 'code_hash'],
      ['oauth_tokens', 'token_hash'],
      ['oauth_state', 'state_hash'],
    ]) {
      expect(sql).toMatch(new RegExp(`create unique index \\w+ on ${tbl} \\(${col}\\)`, 'i'));
    }
    for (const t of ['oauth_codes', 'oauth_tokens', 'oauth_state']) {
      expect(sql).toMatch(new RegExp(`create index \\w+ on ${t} \\(expires_at\\)`, 'i'));
    }
  });
});
