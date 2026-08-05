-- daybrief initial schema (PRD §12). Run in the Supabase SQL editor (or `supabase db push`).
-- Principles: append-only artifacts (regeneration = new version), raw provider payloads kept.

create extension if not exists vector with schema extensions;

create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  gcal_connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text,
  affinity_org_id text,
  first_met_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  email text,
  name text,
  linkedin_url text,
  company_id uuid references companies(id),
  affinity_person_id text,
  created_at timestamptz not null default now()
);

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  gcal_event_id text,
  partner_id uuid references partners(id),
  starts_at timestamptz,
  ends_at timestamptz,
  title text,
  classification text check (classification in ('first_meeting','follow_up','portfolio','lp','other','internal')),
  classification_confidence text check (classification_confidence in ('high','medium','low')),
  company_id uuid references companies(id),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique (gcal_event_id, partner_id)
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('nightly','brief','deep_dive','eval')),
  inngest_run_id text,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cost_usd numeric(10,4),
  summary jsonb,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id),
  meeting_id uuid references meetings(id),
  company_id uuid references companies(id),
  kind text not null check (kind in ('brief','deep_dive','eval')),
  version int not null default 1,
  content jsonb not null,
  content_md text,
  -- Dimension matches EMBEDDING_MODEL; adjust if the M0 eval picks a different embedding size.
  embedding extensions.vector(1536),
  flagged boolean not null default false,
  flag_note text,
  created_at timestamptz not null default now()
);

create table if not exists provider_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id),
  provider text not null check (provider in ('openrouter','parallel','exa','google','affinity','granola')),
  request jsonb,
  response jsonb,
  model_or_processor text,
  tokens int,
  cost_usd numeric(10,6),
  latency_ms int,
  created_at timestamptz not null default now()
);

-- Full-text search over rendered artifact content (PRD §13).
alter table artifacts
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(content_md, ''))) stored;
create index if not exists artifacts_fts_idx on artifacts using gin (fts);
create index if not exists artifacts_company_idx on artifacts (company_id, created_at desc);
-- Concurrent regenerations must not silently share a version number.
create unique index if not exists artifacts_version_uniq on artifacts (company_id, kind, version);
create index if not exists provider_calls_run_idx on provider_calls (run_id);

-- RLS on (PRD §14). The CLI and jobs use the service-role/secret key, which bypasses RLS.
-- Authenticated-partner read policies are added in M2 with the dashboard.
alter table partners enable row level security;
alter table companies enable row level security;
alter table people enable row level security;
alter table meetings enable row level security;
alter table runs enable row level security;
alter table artifacts enable row level security;
alter table provider_calls enable row level security;

-- Fresh Supabase projects don't expose tables through the Data API until
-- privileges are granted; the service role needs these for the CLI/jobs.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
