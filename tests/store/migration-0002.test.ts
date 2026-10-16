import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(resolve(__dirname, '../../supabase/migrations/0002_intuit.sql'), 'utf8');
const sql = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('0002_intuit.sql', () => {
  it('creates no tables and changes no grants, so the RLS posture of 0001 is untouched', () => {
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/i);
    expect(sql).not.toMatch(/drop\s+(table|policy)/i);
  });

  it('keeps RLS enabled on the tables it alters', () => {
    for (const t of ['accounts', 'google_org_clients']) {
      expect(sql).toMatch(new RegExp(`alter table\\s+${t}\\s+enable row level security\\s*;`, 'i'));
    }
  });

  it('adds intuit to the provider check and requires realm_id for it', () => {
    expect(sql).toMatch(/check \(provider in \('google', 'microsoft', 'intuit'\)\)/i);
    expect(sql).toMatch(/add column if not exists realm_id text\s*;/i);
    expect(sql).toMatch(/check \(provider <> 'intuit' or realm_id is not null\)/i);
  });

  it('gives org clients a provider, a nullable workspace_domain that Google still requires', () => {
    expect(sql).toMatch(/add column if not exists provider text not null default 'google'/i);
    expect(sql).toMatch(/check \(provider in \('google', 'intuit'\)\)/i);
    expect(sql).toMatch(/alter column workspace_domain drop not null/i);
    expect(sql).toMatch(/check \(provider <> 'google' or workspace_domain is not null\)/i);
  });

  it('makes labels unique per provider and drops the global unique constraints', () => {
    expect(sql).toMatch(/drop constraint if exists accounts_label_key/i);
    expect(sql).toMatch(/drop constraint if exists google_org_clients_label_key/i);
    expect(sql).toMatch(/create unique index if not exists \w+ on accounts \(provider, label\)/i);
    expect(sql).toMatch(/create unique index if not exists \w+ on google_org_clients \(provider, label\)/i);
  });

  it('keeps email unique for google and makes intuit unique by company', () => {
    expect(sql).toMatch(/on accounts \(provider, email\) where provider <> 'intuit'/i);
    expect(sql).toMatch(/on accounts \(provider, realm_id\) where realm_id is not null/i);
  });

  it('is safe to run twice: every create is guarded', () => {
    for (const m of sql.matchAll(/create\s+(unique\s+)?index\s+(if not exists\s+)?/gi)) expect(m[2]).toBeTruthy();
    for (const m of sql.matchAll(/add column\s+(if not exists\s+)?/gi)) expect(m[1]).toBeTruthy();
    // Each constraint it adds is dropped first.
    for (const m of sql.matchAll(/add constraint\s+(\w+)/gi)) {
      expect(sql).toMatch(new RegExp(`drop constraint if exists ${m[1]}\\b`, 'i'));
    }
  });

  it('adds no secret-like column', () => {
    for (const m of sql.matchAll(/add column\s+(?:if not exists\s+)?(\w+)/gi)) {
      expect(m[1]).not.toMatch(/(secret|token|refresh)/i);
    }
  });
});
