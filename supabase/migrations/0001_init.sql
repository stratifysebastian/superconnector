-- 0001_init.sql: initial schema for the multi-account Google MCP connector.
--
-- Access model: the Next.js server is the ONLY client of this database and it
-- connects with the Supabase service role key (which bypasses RLS). Every table
-- therefore has Row Level Security ENABLED with NO policies, and all privileges
-- are revoked from `anon` and `authenticated`, so the public PostgREST API
-- exposes nothing. Never add a policy here; never ship the service role key to a
-- browser.
--
-- Secrets: columns ending `_enc` hold app-layer AES-256-GCM ciphertext (ADR-4).
-- Columns ending `_hash` hold SHA-256 digests of one-time values; the raw value
-- is never stored. audit_log never holds message bodies.

create table google_org_clients (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  client_id text not null,
  client_secret_enc text not null,
  workspace_domain text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  label text not null unique,
  org_client_id uuid not null references google_org_clients (id) on delete cascade,
  priority integer not null default 0,
  connected_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  granted_scopes text[] not null default '{}',
  unique (provider, email)
);
create index accounts_priority_idx on accounts (priority, connected_at);

create table account_tokens (
  account_id uuid primary key references accounts (id) on delete cascade,
  refresh_token_enc text,
  access_token_enc text,
  access_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  tool text not null,
  account text not null,
  target_id text,
  outcome text not null check (outcome in ('ok', 'rejected', 'error')),
  detail text check (detail is null or char_length(detail) <= 200)
);
create index audit_log_at_idx on audit_log (at);

create table oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

create table oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  client_id uuid not null references oauth_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  subject text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index oauth_codes_code_hash_idx on oauth_codes (code_hash);
create index oauth_codes_expires_at_idx on oauth_codes (expires_at);

create table oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  kind text not null check (kind in ('access', 'refresh')),
  client_id uuid not null references oauth_clients (id) on delete cascade,
  subject text not null,
  family_id text not null,
  revoked boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index oauth_tokens_token_hash_idx on oauth_tokens (token_hash);
create index oauth_tokens_family_idx on oauth_tokens (family_id);
create index oauth_tokens_expires_at_idx on oauth_tokens (expires_at);

create table oauth_state (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null,
  org_client_id uuid not null references google_org_clients (id) on delete cascade,
  account_id uuid references accounts (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index oauth_state_state_hash_idx on oauth_state (state_hash);
create index oauth_state_expires_at_idx on oauth_state (expires_at);

-- Row Level Security: enabled, no policies, nothing for anon/authenticated.
alter table google_org_clients enable row level security;
alter table accounts enable row level security;
alter table account_tokens enable row level security;
alter table audit_log enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
alter table oauth_state enable row level security;

revoke all on table google_org_clients from anon, authenticated;
revoke all on table accounts from anon, authenticated;
revoke all on table account_tokens from anon, authenticated;
revoke all on table audit_log from anon, authenticated;
revoke all on table oauth_clients from anon, authenticated;
revoke all on table oauth_codes from anon, authenticated;
revoke all on table oauth_tokens from anon, authenticated;
revoke all on table oauth_state from anon, authenticated;
