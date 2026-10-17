-- O5 Scoping intelligence: rules and zones with confidence, advice on requests, public intake with consent,
-- AI draft queue. Additive.

create table scoping_rules (
  key text primary key,
  kind text not null check (kind in ('structure', 'zone', 'licence', 'obligation')),
  statement text not null,
  parameters jsonb not null default '{}'::jsonb,
  source_url text not null default '',
  confidence text not null default 'UNCERTAIN' check (confidence in ('verified', 'rule_of_thumb', 'UNCERTAIN')),
  verified_by text,
  verified_at date,
  updated_at timestamptz not null default app_now()
);

create table zones (
  name text primary key,
  emirate text not null,
  type text not null check (type in ('free_zone', 'mainland', 'offshore', 'financial')),
  visa_quota int not null default 0,
  cost_min_fils bigint not null default 0,
  cost_max_fils bigint not null default 0,
  timeline_days int not null default 10,
  activities text[] not null default '{}',
  source_url text not null default '',
  confidence text not null default 'UNCERTAIN' check (confidence in ('verified', 'rule_of_thumb', 'UNCERTAIN')),
  verified_by text,
  verified_at date,
  active boolean not null default true,
  updated_at timestamptz not null default app_now()
);

-- Advice lives on the request; the client sees it only once ops approves.
alter table requests add column advice jsonb;
alter table requests add column advice_status text not null default 'none' check (advice_status in ('none', 'pending_review', 'approved'));
alter table requests add column advice_reviewed_by uuid references users(id);
alter table requests add column advice_reviewed_at timestamptz;
alter table requests add column source jsonb not null default '{}'::jsonb;

-- PDPL consent captured at intake: when, which text version, from where.
alter table users add column consent jsonb;

-- AI output is a draft until a person approves or discards it.
create table ai_drafts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('scope', 'quote_chaser', 'risk_flag')),
  request_id uuid references requests(id),
  engagement_id uuid references engagements(id),
  model text not null,
  input jsonb not null,
  output jsonb not null,
  confidence text not null default 'UNCERTAIN',
  status text not null default 'pending' check (status in ('pending', 'approved', 'discarded')),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default app_now()
);
create index on ai_drafts (status, created_at desc);

grant all on scoping_rules, zones, ai_drafts to app_platform;
alter table scoping_rules enable row level security;
alter table zones enable row level security;
alter table ai_drafts enable row level security;
create policy scoping_rules_platform on scoping_rules for all to app_platform using (true) with check (true);
create policy zones_platform on zones for all to app_platform using (true) with check (true);
create policy ai_drafts_platform on ai_drafts for all to app_platform using (true) with check (true);
