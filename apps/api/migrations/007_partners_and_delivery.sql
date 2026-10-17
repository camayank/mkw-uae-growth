-- O6 Partners and delivery: onboarding documents, licence watch, scorecards, partner staff, client document
-- requests, delay watch and service guarantee, ratings, manual allocation.

-- Partner onboarding documents: uploaded by the partner, verified by MKW. Platform-only table; the partner
-- reads its own rows through the service (never another firm's).
create table partner_documents (
  id uuid primary key default gen_random_uuid(),
  partner_org_id uuid not null references orgs(id),
  kind text not null check (kind in ('trade_licence', 'insurance', 'bank_letter', 'agreement', 'other')),
  file_key text not null,
  file_name text not null,
  uploaded_by uuid not null references users(id),
  uploaded_at timestamptz not null default app_now(),
  -- What the document says, as typed by the partner and checked by MKW.
  reference text,
  expires_on date,
  status text not null default 'uploaded' check (status in ('uploaded', 'verified', 'rejected', 'superseded')),
  verified_by uuid references users(id),
  verified_at timestamptz,
  note text
);
create index on partner_documents (partner_org_id, kind, status);

-- Weekly scorecard history: the inputs and the score, so a partner can see why and ops can see the trend.
create table scorecards (
  id uuid primary key default gen_random_uuid(),
  partner_org_id uuid not null references orgs(id),
  computed_at timestamptz not null default app_now(),
  window_from date not null,
  window_to date not null,
  inputs jsonb not null,
  score int not null check (score between 0 and 100),
  parts jsonb not null,
  provisional boolean not null default false
);
create index on scorecards (partner_org_id, computed_at desc);

-- Documents the client supplies before a step can start.
create table document_requests (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  milestone_id uuid not null references milestones(id),
  client_org_id uuid not null references orgs(id),
  partner_org_id uuid not null references orgs(id),
  kind text not null,
  note text,
  status text not null default 'requested' check (status in ('requested', 'uploaded', 'received', 'rejected')),
  file_key text,
  file_name text,
  uploaded_by uuid references users(id),
  uploaded_at timestamptz,
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  requested_by uuid references users(id),
  created_at timestamptz not null default app_now()
);
create index on document_requests (engagement_id, milestone_id);

-- Delay watch: one row per late step, attributed by ops.
create table delays (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null unique references milestones(id),
  engagement_id uuid not null references engagements(id),
  partner_org_id uuid not null references orgs(id),
  client_org_id uuid not null references orgs(id),
  due_date date not null,
  noticed_at timestamptz not null default app_now(),
  expected_date date not null,
  cause text check (cause in ('partner', 'client', 'government', 'mkw')),
  cause_note text,
  attributed_by uuid references users(id),
  attributed_at timestamptz,
  credit_id uuid
);

-- Service guarantee credits: created by rule, moved by finance.
create table guarantee_credits (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  milestone_id uuid not null unique references milestones(id),
  client_org_id uuid not null references orgs(id),
  partner_org_id uuid not null references orgs(id),
  base_fils bigint not null,
  guarantee_bp int not null,
  amount_fils bigint not null check (amount_fils >= 0),
  status text not null default 'pending' check (status in ('pending', 'applied', 'approved', 'settled', 'waived')),
  borne_by_partner boolean not null default false,
  payout_reduction_fils bigint not null default 0,
  decided_by uuid references users(id),
  decided_at timestamptz,
  waive_reason text,
  settled_reference text,
  created_at timestamptz not null default app_now()
);
alter table delays add constraint delays_credit_fk foreign key (credit_id) references guarantee_credits(id);

-- Client ratings at completion: one per engagement.
create table ratings (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null unique references engagements(id),
  client_org_id uuid not null references orgs(id),
  partner_org_id uuid not null references orgs(id),
  author_user_id uuid not null references users(id),
  stars int not null check (stars between 1 and 5),
  comment_original text not null default '',
  comment_shown text not null default '',
  created_at timestamptz not null default app_now()
);

-- The partner's own firm, without MKW's internal fields (conflicts, bank, notes).
create function app_partner_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select (profile - 'conflicts' - 'bank') || jsonb_build_object('latestScore', (select score from scorecards s where s.partner_org_id = app_org() order by computed_at desc limit 1))
  from orgs where id = app_org() and type = 'partner'
$$;
revoke all on function app_partner_profile() from public;
grant execute on function app_partner_profile() to app_partner, app_platform;

-- Licence watch bookkeeping lives in the profile (licenceExpiry, licenceWarnedFor) so one row per partner.

grant all on partner_documents, scorecards, document_requests, delays, guarantee_credits, ratings to app_platform;
alter table partner_documents enable row level security;
alter table scorecards enable row level security;
alter table document_requests enable row level security;
alter table delays enable row level security;
alter table guarantee_credits enable row level security;
alter table ratings enable row level security;
create policy partner_documents_platform on partner_documents for all to app_platform using (true) with check (true);
create policy scorecards_platform on scorecards for all to app_platform using (true) with check (true);
create policy document_requests_platform on document_requests for all to app_platform using (true) with check (true);
create policy delays_platform on delays for all to app_platform using (true) with check (true);
create policy guarantee_credits_platform on guarantee_credits for all to app_platform using (true) with check (true);
create policy ratings_platform on ratings for all to app_platform using (true) with check (true);

-- Each party reads its own document requests; the delay row without its attribution; the client its credits;
-- ratings: the client its own, the partner the stars and shown comment only.
grant select (id, engagement_id, milestone_id, kind, note, status, file_name, uploaded_at, decided_at, decision_note, created_at) on document_requests to app_client, app_partner;
create policy document_requests_client on document_requests for select to app_client using (client_org_id = app_org());
create policy document_requests_partner on document_requests for select to app_partner using (partner_org_id = app_org());
grant select (id, milestone_id, engagement_id, due_date, noticed_at, expected_date) on delays to app_client, app_partner;
create policy delays_client on delays for select to app_client using (client_org_id = app_org());
create policy delays_partner on delays for select to app_partner using (partner_org_id = app_org());
grant select (id, engagement_id, milestone_id, amount_fils, status, settled_reference, created_at) on guarantee_credits to app_client;
create policy guarantee_credits_client on guarantee_credits for select to app_client using (client_org_id = app_org());
grant select (id, engagement_id, stars, comment_shown, created_at) on ratings to app_client, app_partner;
create policy ratings_client on ratings for select to app_client using (client_org_id = app_org());
create policy ratings_partner on ratings for select to app_partner using (partner_org_id = app_org());

-- Retention: scorecards and delays follow the engagement record.
insert into settings (key, value) values ('guarantee_bp', '1000') on conflict (key) do nothing;
