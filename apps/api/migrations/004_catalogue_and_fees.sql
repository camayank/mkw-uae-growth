-- O4 Catalogue and fees: the full catalogue, a government fee table with sources and verification, and
-- margin rules with effective dates. Additive.

alter table deliverables add column sheet_row int;
alter table deliverables add column active boolean not null default true;

-- Every rate and floor ever in force, with the date it took effect. margin_rules keeps the version in force
-- today as a cache for code that reads it; pricing loads the version effective on the build date.
create table margin_rule_versions (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  rate_bp int not null check (rate_bp between 0 and 10000),
  floor_fils bigint not null check (floor_fils >= 0),
  effective_from date not null,
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default app_now(),
  unique (category, effective_from)
);
insert into margin_rule_versions (category, rate_bp, floor_fils, effective_from, note)
  select category, rate_bp, floor_fils, date '2026-01-01', 'Starter rule from the Deliverable Codes tab' from margin_rules;

-- Government fees MKW charges at cost, per code and place. UNCERTAIN until a named person verifies; stale 90
-- days after verification. A free-zone row beats an emirate-wide row (free_zone null) for the same code.
create table government_fees (
  id uuid primary key default gen_random_uuid(),
  code text not null references deliverables(code),
  emirate text not null,
  free_zone text,
  fee_fils bigint not null check (fee_fils >= 0),
  source_url text not null default '',
  source_note text not null default '',
  effective_from date not null default app_now()::date,
  confidence text not null default 'UNCERTAIN' check (confidence in ('UNCERTAIN', 'verified')),
  verified_by text,
  verified_at date,
  created_by uuid references users(id),
  created_at timestamptz not null default app_now(),
  retired_at timestamptz
);
create index on government_fees (code, emirate, free_zone);

-- Which rule set an offer was priced under, so a later change never re-prices an earlier offer.
alter table offers add column rules_as_of date;

-- Rates, floors and the fee table are MKW's own: platform only. Clients see fees on their offers, partners never.
grant all on margin_rule_versions, government_fees to app_platform;
alter table margin_rule_versions enable row level security;
alter table government_fees enable row level security;
create policy mrv_platform on margin_rule_versions for all to app_platform using (true) with check (true);
create policy gf_platform on government_fees for all to app_platform using (true) with check (true);

-- One live row per code, place and effective date, whatever two people do at once.
create unique index government_fees_live_unique on government_fees (code, emirate, coalesce(free_zone, ''), effective_from) where retired_at is null;
