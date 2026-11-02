-- E4 Lead intelligence: assessment sessions, leads as their own identity, consents per purpose, routing and
-- follow-ups. Additive.

-- A saved public assessment: answers and the public result's summary, with no contact details. The recovery code
-- is stored hashed; the founder keeps the code. Anonymised after the retention period.
create table assessments (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  answers jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  source jsonb not null default '{}'::jsonb,
  engine_version text,
  data_as_of date,
  status text not null default 'open' check (status in ('open', 'lead', 'anonymised')),
  created_at timestamptz not null default app_now(),
  last_seen_at timestamptz not null default app_now(),
  recovered int not null default 0
);

-- A lead: one person who asked for a review, with the session and source it came from and what it became. Never a
-- user; a user is never a lead.
create table leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  company text not null,
  phone_given boolean not null default false,
  assessment_id uuid references assessments(id),
  answers jsonb not null,
  source jsonb not null default '{}'::jsonb,
  segment text not null check (segment in ('starter', 'standard', 'complex', 'regulated', 'cross_border')),
  complexity int not null check (complexity between 0 and 100),
  intent int not null check (intent between 0 and 100),
  high_intent boolean not null default false,
  consultation jsonb,
  status text not null default 'new' check (status in ('new', 'routed', 'contacted', 'consultation', 'converted', 'closed', 'anonymised')),
  owner_user_id uuid references users(id),
  client_org_id uuid references orgs(id),
  request_id uuid references requests(id),
  intake_lead_id uuid references intake_leads(id),
  ip text,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now()
);
create index leads_status on leads (status, created_at desc);
create index leads_owner on leads (owner_user_id) where status not in ('converted', 'closed', 'anonymised');

-- Consents, one record per purpose and decision (PDPL). A withdrawal is a new record; nothing is edited.
create table consents (
  id bigserial primary key,
  subject_kind text not null check (subject_kind in ('lead', 'user')),
  subject_id uuid not null,
  purpose text not null check (purpose in ('service', 'marketing', 'partner_disclosure')),
  given boolean not null,
  version text not null,
  channel text not null,
  at timestamptz not null default app_now()
);
create index consents_subject on consents (subject_kind, subject_id, purpose, id desc);
create function consents_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'consents are append-only: record a withdrawal instead';
end $$;
create trigger consents_no_update before update or delete on consents for each row execute function consents_append_only();

-- Notes, status changes and follow-up tasks on a lead: internal, never sent.
create table lead_notes (
  id bigserial primary key,
  lead_id uuid not null references leads(id),
  author_user_id uuid references users(id),
  kind text not null check (kind in ('note', 'status', 'assigned', 'followup', 'followup_done')),
  body text not null default '',
  due_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default app_now()
);
create index lead_notes_due on lead_notes (due_at) where kind = 'followup' and done_at is null;

-- Routing: which person owns each segment (the founder sets it on Settings); unmapped segments go to ops.
insert into settings (key, value) values ('lead_routing', '{}'::jsonb) on conflict (key) do nothing;
-- Retention: leads and sessions that never became a client, as a period alongside the others (UNCERTAIN until the
-- founder confirms the periods).
update settings set value = jsonb_set(value, '{periods,leads}', '{"days": 365, "years": null, "basis": "Leads and saved assessments that never became a client: anonymised after this period, counts kept for analytics", "confidence": "UNCERTAIN"}'::jsonb, true)
 where key = 'retention' and not (value->'periods' ? 'leads');

grant all on assessments, leads, lead_notes to app_platform;
grant select, insert on consents to app_platform;
grant usage, select on sequence consents_id_seq, lead_notes_id_seq to app_platform;
alter table assessments enable row level security;
alter table leads enable row level security;
alter table consents enable row level security;
alter table lead_notes enable row level security;
create policy assessments_platform on assessments for all to app_platform using (true) with check (true);
create policy leads_platform on leads for all to app_platform using (true) with check (true);
create policy consents_platform on consents for all to app_platform using (true) with check (true);
create policy lead_notes_platform on lead_notes for all to app_platform using (true) with check (true);
