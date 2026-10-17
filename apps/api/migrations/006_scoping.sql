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

-- Advice is held from the client until ops approves it, at the database too: the client role cannot read the
-- advice column at all and gets approved advice through a definer function.
revoke select on requests from app_client;
grant select (id, client_org_id, answers, scope, notes, status, sourced_by_partner_id, created_by, created_at, advice_status, advice_reviewed_at)
  on requests to app_client;
create function app_approved_advice(r uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select advice from requests where id = r and advice_status = 'approved' and client_org_id = app_org()
$$;
revoke all on function app_approved_advice(uuid) from public;
grant execute on function app_approved_advice(uuid) to app_client, app_platform;

-- A lead from the public page whose email already has an account is held here for a person to look at; it
-- never attaches to the existing account, writes nothing as that person and never overwrites their consent.
create table intake_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  company text not null,
  name text not null,
  phone_given boolean not null default false,
  answers jsonb not null,
  consent jsonb not null,
  source jsonb not null default '{}'::jsonb,
  ip text,
  status text not null default 'held' check (status in ('held', 'handled')),
  handled_by uuid references users(id),
  handled_at timestamptz,
  created_at timestamptz not null default app_now()
);
create index on intake_leads (status, created_at desc);

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

grant all on scoping_rules, zones, ai_drafts, intake_leads to app_platform;
alter table intake_leads enable row level security;
create policy intake_leads_platform on intake_leads for all to app_platform using (true) with check (true);
alter table scoping_rules enable row level security;
alter table zones enable row level security;
alter table ai_drafts enable row level security;
create policy scoping_rules_platform on scoping_rules for all to app_platform using (true) with check (true);
create policy zones_platform on zones for all to app_platform using (true) with check (true);
create policy ai_drafts_platform on ai_drafts for all to app_platform using (true) with check (true);
