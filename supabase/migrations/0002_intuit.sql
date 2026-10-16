-- 0002_intuit.sql: QuickBooks Online (provider 'intuit') alongside Google.
--
-- Same access model as 0001: RLS stays ENABLED with NO policies on every table and nothing is
-- granted to `anon` or `authenticated`. This file creates no tables and changes no grants.
-- Re-runnable: every statement is guarded or drops what it re-adds.
--
-- Labels become unique per provider, so 'stratify' (google) and 'stratify-ca' (intuit) coexist and a
-- QuickBooks label may equal a Google label. A Google account is one (provider, email); an Intuit
-- account is one company, (provider, realm_id), and two companies may share an email.
--
-- google_org_clients keeps its name but now holds app credentials for both providers. An Intuit
-- client has no Workspace domain, so workspace_domain becomes nullable for it.

-- accounts: provider check gains 'intuit'; realm_id is the QuickBooks company.
alter table accounts drop constraint if exists accounts_provider_check;
alter table accounts add constraint accounts_provider_check check (provider in ('google', 'microsoft', 'intuit'));

alter table accounts add column if not exists realm_id text;
-- Display name from QuickBooks CompanyInfo, shown on /connect only. Never logged.
alter table accounts add column if not exists company_name text;
alter table accounts drop constraint if exists accounts_intuit_realm_check;
alter table accounts add constraint accounts_intuit_realm_check check (provider <> 'intuit' or realm_id is not null);

-- accounts: label unique per provider (was globally unique).
alter table accounts drop constraint if exists accounts_label_key;
create unique index if not exists accounts_provider_label_idx on accounts (provider, label);

-- accounts: email is unique for google; intuit accounts are unique by company instead.
alter table accounts drop constraint if exists accounts_provider_email_key;
create unique index if not exists accounts_provider_email_idx on accounts (provider, email) where provider <> 'intuit';
create unique index if not exists accounts_provider_realm_idx on accounts (provider, realm_id) where realm_id is not null;

-- google_org_clients: which provider the client credentials are for.
alter table google_org_clients add column if not exists provider text not null default 'google';
alter table google_org_clients drop constraint if exists google_org_clients_provider_check;
alter table google_org_clients add constraint google_org_clients_provider_check check (provider in ('google', 'intuit'));

alter table google_org_clients alter column workspace_domain drop not null;
alter table google_org_clients drop constraint if exists google_org_clients_workspace_domain_check;
alter table google_org_clients add constraint google_org_clients_workspace_domain_check
  check (provider <> 'google' or workspace_domain is not null);

-- google_org_clients: label unique per provider (was globally unique).
alter table google_org_clients drop constraint if exists google_org_clients_label_key;
create unique index if not exists google_org_clients_provider_label_idx on google_org_clients (provider, label);

-- Row Level Security: unchanged (enabled, no policies). Restated so a partial replay stays safe.
alter table google_org_clients enable row level security;
alter table accounts enable row level security;
