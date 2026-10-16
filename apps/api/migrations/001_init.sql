-- Tasees platform schema.
-- Reads run under one of three database roles (app_client, app_partner, app_platform) with
-- row-level security and column grants, so a client or partner session cannot select
-- another party's rows or any margin column, even if application code has a bug.
-- Writes are made by server-side commands under app_platform after authorisation in code.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_client') then create role app_client nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_partner') then create role app_partner nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_platform') then create role app_platform nologin; end if;
end $$;

grant app_client, app_partner, app_platform to current_user;
grant usage on schema public to app_client, app_partner, app_platform;

create function app_org() returns uuid language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- The application clock. Tests and replays set app.now per transaction; production leaves it unset.
create function app_now() returns timestamptz language sql stable as $$
  select coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$;

-- Parties and people -------------------------------------------------------

create table orgs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('client', 'partner', 'platform')),
  name text not null,
  status text not null default 'active',
  -- Partner profile: licence checks, coverage, capacity, scorecard inputs. Platform-only column.
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default app_now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  email text not null unique check (email = lower(email)),
  name text not null,
  role text not null check (role in ('client_owner','client_member','partner_admin','partner_staff','ops','finance','founder','agent')),
  created_at timestamptz not null default app_now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default app_now()
);

create table login_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);

-- Catalogue and pricing rules ----------------------------------------------

create table deliverables (
  code text primary key,
  name text not null,
  category text not null,
  model text not null check (model in ('reseller', 'agent')),
  billing text not null check (billing in ('one_off', 'monthly', 'yearly')),
  market_mid_fils bigint not null check (market_mid_fils >= 0),
  mid_basis text not null check (mid_basis in ('incl_govt', 'service_only')),
  gov_fee_fils bigint,
  required_evidence text[] not null default '{}',
  requires text[] not null default '{}'
);

create table margin_rules (
  category text primary key,
  rate_bp int not null check (rate_bp between 0 and 10000),
  floor_fils bigint not null check (floor_fils >= 0)
);

create table settings (
  key text primary key,
  value jsonb not null
);

-- Supply ------------------------------------------------------------------

create table rate_cards (
  id uuid primary key default gen_random_uuid(),
  partner_org_id uuid not null references orgs(id),
  code text not null references deliverables(code),
  professional_fils bigint not null check (professional_fils >= 0),
  gov_stated_fils bigint not null default 0 check (gov_stated_fils >= 0),
  third_party_fils bigint not null default 0 check (third_party_fils >= 0),
  working_days int not null check (working_days > 0),
  exclusions text[] not null default '{}',
  gap_fils bigint not null default 0 check (gap_fils >= 0),
  valid_to date not null,
  updated_at timestamptz not null default app_now(),
  unique (partner_org_id, code)
);

-- Demand ------------------------------------------------------------------

create table requests (
  id uuid primary key default gen_random_uuid(),
  client_org_id uuid not null references orgs(id),
  answers jsonb not null,
  scope jsonb not null,
  notes text[] not null default '{}',
  status text not null default 'scoped',
  sourced_by_partner_id uuid references orgs(id),
  created_by uuid references users(id),
  created_at timestamptz not null default app_now()
);

create table quote_requests (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id),
  deadline timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default app_now()
);

create table quote_invites (
  quote_request_id uuid not null references quote_requests(id),
  partner_org_id uuid not null references orgs(id),
  primary key (quote_request_id, partner_org_id)
);

create table partner_quotes (
  id uuid primary key default gen_random_uuid(),
  quote_request_id uuid not null references quote_requests(id),
  partner_org_id uuid not null references orgs(id),
  submitted_at timestamptz not null default app_now(),
  unique (quote_request_id, partner_org_id)
);

create table partner_quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references partner_quotes(id),
  code text not null references deliverables(code),
  professional_fils bigint not null check (professional_fils >= 0),
  gov_stated_fils bigint not null default 0,
  third_party_fils bigint not null default 0,
  working_days int not null check (working_days > 0),
  exclusions text[] not null default '{}',
  gap_fils bigint not null default 0,
  assumptions text not null default ''
);

create table offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id),
  client_org_id uuid not null references orgs(id),
  tier text not null check (tier in ('essential', 'standard', 'priority')),
  status text not null,
  valid_to date not null,
  professional_fils bigint not null,
  mkw_fees_fils bigint not null,
  vat_fils bigint not null,
  government_fils bigint not null,
  client_total_fils bigint not null,
  partner_payout_fils bigint not null,
  margin_fils bigint not null,
  margin_bp int not null,
  lines_needing_review int not null,
  created_at timestamptz not null default app_now(),
  published_at timestamptz,
  accepted_at timestamptz
);

create table offer_lines (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references offers(id),
  code text not null references deliverables(code),
  qty int not null check (qty > 0),
  model text not null,
  partner_org_id uuid references orgs(id),
  fallback_partner_org_id uuid references orgs(id),
  cost_source_id text,
  partner_unit_fils bigint not null,
  gov_unit_fils bigint not null,
  client_unit_fils bigint not null,
  mkw_fee_unit_fils bigint not null,
  margin_unit_fils bigint not null,
  cap_unit_fils bigint not null,
  status text not null,
  reason text
);

-- Delivery ----------------------------------------------------------------

create table engagements (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null unique references offers(id),
  request_id uuid not null references requests(id),
  client_org_id uuid not null references orgs(id),
  status text not null,
  emirate text not null,
  free_zone text,
  created_at timestamptz not null default app_now(),
  completed_at timestamptz
);

create table engagement_parties (
  engagement_id uuid not null references engagements(id),
  org_id uuid not null references orgs(id),
  party text not null check (party in ('client', 'partner')),
  primary key (engagement_id, org_id)
);

create table engagement_lines (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  code text not null references deliverables(code),
  qty int not null,
  partner_org_id uuid references orgs(id),
  quoting_partner_org_id uuid references orgs(id),
  fallback_partner_org_id uuid references orgs(id),
  partner_unit_fils bigint not null,
  gov_unit_fils bigint not null,
  client_unit_fils bigint not null
);

create table allocations (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  partner_org_id uuid not null references orgs(id),
  codes text[] not null,
  reason text not null,
  offered_at timestamptz not null default app_now(),
  deadline timestamptz not null,
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  timed_out_at timestamptz,
  fallback_org_id uuid references orgs(id),
  -- What the partner will be paid per line if it accepts: [{code, qty, unitFils}].
  payout_lines jsonb not null default '[]'::jsonb,
  -- What the partner needs to decide before it becomes a party: emirate, zone, lines. No client identity.
  brief jsonb not null default '{}'::jsonb
);

create table milestones (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  partner_org_id uuid references orgs(id),
  code text not null,
  seq int not null,
  name text not null,
  is_key boolean not null default false,
  due_date date,
  status text not null default 'pending',
  evidence_required text[] not null default '{}',
  qa_note text,
  dispute_reason text,
  qa_passed_at timestamptz,
  updated_at timestamptz not null default app_now()
);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references milestones(id),
  engagement_id uuid not null references engagements(id),
  type text not null,
  file_key text not null,
  file_name text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default app_now()
);

create table change_orders (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  raised_by_org uuid not null references orgs(id),
  description text not null,
  partner_fils bigint not null check (partner_fils >= 0),
  client_fils bigint,
  status text not null default 'proposed',
  created_at timestamptz not null default app_now(),
  decided_at timestamptz
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  author_user_id uuid references users(id),
  author_org_id uuid references orgs(id),
  author_name text not null,
  body_original text not null,
  body_shown text not null,
  masked boolean not null default false,
  created_at timestamptz not null default app_now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  client_org_id uuid not null references orgs(id),
  kind text not null check (kind in ('deposit', 'balance', 'change_order')),
  amount_fils bigint not null,
  status text not null check (status in ('scheduled', 'pending', 'paid', 'refunded')),
  provider_ref text,
  created_at timestamptz not null default app_now(),
  paid_at timestamptz
);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  partner_org_id uuid not null references orgs(id),
  stage text not null check (stage in ('kickoff', 'key_milestone', 'completion', 'change_order')),
  amount_fils bigint not null,
  status text not null default 'pending' check (status in ('pending', 'eligible', 'released', 'withheld')),
  released_by uuid references users(id),
  released_at timestamptz
);

create table audit_events (
  id bigserial primary key,
  at timestamptz not null default app_now(),
  actor_user_id uuid,
  actor_org_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null
);

create index on engagement_parties (org_id);
create index on milestones (engagement_id);
create index on allocations (engagement_id);
create index on offer_lines (offer_id);
create index on engagement_lines (engagement_id);
create index on messages (engagement_id);

-- Helpers used by policies. SECURITY DEFINER so a policy can look up parties without recursion.

create function app_is_party(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from engagement_parties where engagement_id = e and org_id = app_org())
$$;

create function app_partner_invited(qr uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from quote_invites where quote_request_id = qr and partner_org_id = app_org())
$$;

create function app_request_visible_to_partner(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from quote_requests q join quote_invites i on i.quote_request_id = q.id
    where q.request_id = r and i.partner_org_id = app_org()
  )
$$;

create function app_shares_engagement(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from engagement_parties a join engagement_parties b on a.engagement_id = b.engagement_id
    where a.org_id = app_org() and b.org_id = o
  )
$$;

-- Hash-chained audit trail. Every role may append; only the platform may read.
create function audit_append(p_actor uuid, p_org uuid, p_action text, p_entity text, p_entity_id text, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_prev text;
  v_hash text;
  v_id bigint;
  v_at timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(777001);
  select hash into v_prev from audit_events order by id desc limit 1;
  v_prev := coalesce(v_prev, 'genesis');
  v_hash := encode(sha256(convert_to(
    v_prev || '|' || v_at::text || '|' || coalesce(p_actor::text, '') || '|' || p_action || '|' || p_entity || '|' ||
    coalesce(p_entity_id, '') || '|' || coalesce(p_data::text, '{}'), 'UTF8')), 'hex');
  insert into audit_events (at, actor_user_id, actor_org_id, action, entity, entity_id, data, prev_hash, hash)
  values (v_at, p_actor, p_org, p_action, p_entity, p_entity_id, coalesce(p_data, '{}'::jsonb), v_prev, v_hash)
  returning id into v_id;
  return v_id;
end $$;

-- Grants -------------------------------------------------------------------

grant all on all tables in schema public to app_platform;
grant usage, select on all sequences in schema public to app_platform;
grant execute on function audit_append(uuid, uuid, text, text, text, jsonb) to app_client, app_partner, app_platform;

-- Shared reference data
grant select on deliverables to app_client, app_partner;

-- Clients: no partner cost, margin, payout or quote columns, ever.
grant select (id, type, name) on orgs to app_client, app_partner;
grant select (id, org_id, email, name, role) on users to app_client, app_partner;
grant select on requests to app_client;
grant select (id, request_id, client_org_id, tier, status, valid_to, professional_fils, mkw_fees_fils, vat_fils,
              government_fils, client_total_fils, created_at, published_at, accepted_at) on offers to app_client;
grant select (id, offer_id, code, qty, model, gov_unit_fils, client_unit_fils, mkw_fee_unit_fils) on offer_lines to app_client;
grant select on engagements, engagement_parties to app_client, app_partner;
grant select (id, engagement_id, code, qty, gov_unit_fils, client_unit_fils) on engagement_lines to app_client;
grant select (id, engagement_id, partner_org_id, accepted_at) on allocations to app_client;
grant select on milestones, evidence to app_client, app_partner;
grant select (id, engagement_id, raised_by_org, description, client_fils, status, created_at, decided_at) on change_orders to app_client;
grant select (id, engagement_id, author_org_id, author_name, body_shown, masked, created_at) on messages to app_client, app_partner;
grant select on payments to app_client;

-- Partners: their own cost, quotes and payouts; never the client price or margin.
grant select (id, scope, notes, created_at) on requests to app_partner;
grant select on rate_cards, quote_requests, quote_invites, partner_quotes, partner_quote_lines to app_partner;
grant select (id, engagement_id, code, qty, gov_unit_fils, partner_org_id, partner_unit_fils) on engagement_lines to app_partner;
grant select (id, engagement_id, partner_org_id, codes, reason, offered_at, deadline, accepted_at, declined_at, decline_reason, timed_out_at, payout_lines, brief) on allocations to app_partner;
grant select (id, engagement_id, raised_by_org, description, partner_fils, status, created_at, decided_at) on change_orders to app_partner;
grant select on payouts to app_partner;

-- Row-level security ------------------------------------------------------

alter table orgs enable row level security;
alter table users enable row level security;
alter table rate_cards enable row level security;
alter table requests enable row level security;
alter table quote_requests enable row level security;
alter table quote_invites enable row level security;
alter table partner_quotes enable row level security;
alter table partner_quote_lines enable row level security;
alter table offers enable row level security;
alter table offer_lines enable row level security;
alter table engagements enable row level security;
alter table engagement_parties enable row level security;
alter table engagement_lines enable row level security;
alter table allocations enable row level security;
alter table milestones enable row level security;
alter table evidence enable row level security;
alter table change_orders enable row level security;
alter table messages enable row level security;
alter table payments enable row level security;
alter table payouts enable row level security;
alter table audit_events enable row level security;

-- Platform sees and writes everything.
do $$
declare t text;
begin
  foreach t in array array['orgs','users','rate_cards','requests','quote_requests','quote_invites','partner_quotes',
    'partner_quote_lines','offers','offer_lines','engagements','engagement_parties','engagement_lines','allocations',
    'milestones','evidence','change_orders','messages','payments','payouts','audit_events']
  loop
    execute format('create policy %I on %I for all to app_platform using (true) with check (true)', t || '_platform', t);
  end loop;
end $$;

create policy orgs_visible on orgs for select to app_client, app_partner
  using (id = app_org() or app_shares_engagement(id));
create policy users_own_org on users for select to app_client, app_partner using (org_id = app_org());

create policy requests_client on requests for select to app_client using (client_org_id = app_org());
create policy requests_partner on requests for select to app_partner using (app_request_visible_to_partner(id));

create policy rate_cards_own on rate_cards for select to app_partner using (partner_org_id = app_org());
create policy qr_invited on quote_requests for select to app_partner using (app_partner_invited(id));
create policy qi_own on quote_invites for select to app_partner using (partner_org_id = app_org());
create policy pq_own on partner_quotes for select to app_partner using (partner_org_id = app_org());
create policy pql_own on partner_quote_lines for select to app_partner
  using (exists (select 1 from partner_quotes q where q.id = quote_id and q.partner_org_id = app_org()));

create policy offers_client on offers for select to app_client
  using (client_org_id = app_org() and status in ('published', 'accepted', 'expired'));
create policy offer_lines_client on offer_lines for select to app_client
  using (exists (select 1 from offers o where o.id = offer_id and o.client_org_id = app_org()
                 and o.status in ('published', 'accepted', 'expired')));

create policy engagements_party on engagements for select to app_client, app_partner using (app_is_party(id));
create policy parties_party on engagement_parties for select to app_client, app_partner using (app_is_party(engagement_id));
create policy eng_lines_client on engagement_lines for select to app_client using (app_is_party(engagement_id));
create policy eng_lines_partner on engagement_lines for select to app_partner using (partner_org_id = app_org());
create policy allocations_client on allocations for select to app_client
  using (app_is_party(engagement_id) and accepted_at is not null);
create policy allocations_partner on allocations for select to app_partner using (partner_org_id = app_org());
create policy milestones_client on milestones for select to app_client using (app_is_party(engagement_id));
create policy milestones_partner on milestones for select to app_partner using (partner_org_id = app_org());
create policy evidence_client on evidence for select to app_client using (app_is_party(engagement_id));
create policy evidence_partner on evidence for select to app_partner
  using (exists (select 1 from milestones m where m.id = milestone_id and m.partner_org_id = app_org()));
create policy co_party on change_orders for select to app_client, app_partner using (app_is_party(engagement_id));
create policy messages_party on messages for select to app_client, app_partner using (app_is_party(engagement_id));
create policy payments_client on payments for select to app_client using (client_org_id = app_org());
create policy payouts_partner on payouts for select to app_partner using (partner_org_id = app_org());

