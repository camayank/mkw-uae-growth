-- E2 Jurisdiction catalogue and evidence. Additive: new tables and nullable columns only.

-- Licensing and registration authorities. A parent authority or registrar is set only from a recorded fact with a
-- source (catalogue_facts), never assumed.
create table authorities (
  id text primary key check (id ~ '^[a-z0-9_]+$'),
  name text not null unique,
  kind text not null check (kind in ('free_zone_authority', 'mainland_department', 'offshore_registry', 'financial_centre', 'regulator')),
  emirate text,
  parent_id text references authorities(id),
  registrar text,
  website text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default app_now()
);

-- Other names founders use for an authority ("Sharjah Media City" for Shams), matched case- and space-insensitively.
create table authority_aliases (
  alias_norm text primary key,
  alias text not null,
  authority_id text not null references authorities(id)
);

-- The current value of each place fact, kept on the place as a cache of the latest recorded fact (the engine reads
-- these). Null means "not on record", which the engine says rather than assumes.
alter table zones add column authority_id text references authorities(id);
-- A place added without figures: its cost, visas and timeline are placeholders until each is recorded as a fact.
alter table zones add column placeholder boolean not null default false;
alter table zones add column legal_forms text[];
alter table zones add column activities_listed text[];
alter table zones add column renewal_min_fils bigint check (renewal_min_fils is null or renewal_min_fils >= 0);
alter table zones add column renewal_max_fils bigint check (renewal_max_fils is null or renewal_max_fils >= 0);
alter table zones add column latitude numeric(9, 6);
alter table zones add column longitude numeric(9, 6);
alter table zones add constraint zones_coordinates check (
  (latitude is null) = (longitude is null) and (latitude is null or (latitude between 22 and 27 and longitude between 51 and 57))
);

-- Rule versions: each verification is a new version, recorded as a fact, with the date it must be checked again.
alter table scoping_rules add column version int not null default 1;
alter table scoping_rules add column next_verification date;

-- Append-only evidence. A new fact supersedes the previous one for the same subject and field; nothing is ever
-- updated or deleted, so the history of every figure and rule stays readable.
create table catalogue_facts (
  id bigserial primary key,
  subject_kind text not null check (subject_kind in ('place', 'authority', 'rule')),
  subject text not null,
  field text not null,
  value jsonb not null,
  source_url text not null default '',
  evidence_date date not null,
  confidence text not null check (confidence in ('verified', 'rule_of_thumb', 'UNCERTAIN')),
  verified_by text,
  next_verification date,
  note text not null default '',
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default app_now(),
  -- A verified fact names its verifier, links its source and says when it must be checked again.
  constraint catalogue_facts_verified check (
    confidence <> 'verified' or (verified_by is not null and length(btrim(verified_by)) >= 2 and source_url ~* '^https?://[^[:space:]]+$' and next_verification is not null)
  ),
  constraint catalogue_facts_source check (source_url = '' or source_url ~* '^https?://[^[:space:]]+$'),
  constraint catalogue_facts_dates check (next_verification is null or next_verification > evidence_date)
);
create index catalogue_facts_subject on catalogue_facts (subject_kind, subject, field, id desc);

create function catalogue_facts_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'catalogue facts are append-only: record a new fact instead';
end $$;
-- Evidence is never dated in the future, and nothing goes unchecked for more than two years: a fact cannot be made
-- to never go stale.
create function catalogue_facts_dates() returns trigger language plpgsql as $$
begin
  if new.evidence_date > gulf(app_now()) then raise exception 'the evidence date is in the future'; end if;
  if new.next_verification is not null and new.next_verification > new.evidence_date + 730 then raise exception 're-verification must be within two years of the evidence'; end if;
  return new;
end $$;
create trigger catalogue_facts_dates before insert on catalogue_facts for each row execute function catalogue_facts_dates();
create trigger catalogue_facts_no_update before update or delete on catalogue_facts for each row execute function catalogue_facts_append_only();
create trigger catalogue_facts_no_truncate before truncate on catalogue_facts for each statement execute function catalogue_facts_append_only();

grant all on authorities, authority_aliases to app_platform;
grant select, insert on catalogue_facts to app_platform;
grant usage, select on sequence catalogue_facts_id_seq to app_platform;

alter table authorities enable row level security;
alter table authority_aliases enable row level security;
alter table catalogue_facts enable row level security;
create policy authorities_platform on authorities for all to app_platform using (true) with check (true);
create policy authority_aliases_platform on authority_aliases for all to app_platform using (true) with check (true);
create policy catalogue_facts_read on catalogue_facts for select to app_platform using (true);
create policy catalogue_facts_append on catalogue_facts for insert to app_platform with check (true);
