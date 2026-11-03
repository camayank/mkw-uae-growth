-- E7C Lead conversion intelligence. Additive: one table, nullable columns on leads.

-- Aggregate, anonymous funnel measurement from the public pages: a random id the browser keeps for the session,
-- the stage reached, a key (the question step, or nothing), the attribution and the time. No cookie, no IP, no
-- user agent, no contact detail. One row per visitor, stage and key, so a repeat never counts twice.
create table funnel_events (
  id bigserial primary key,
  visitor text not null check (visitor ~ '^[A-Za-z0-9_-]{8,32}$'),
  stage text not null check (stage in ('visited', 'assessment_started', 'step_reached', 'assessment_completed', 'result_viewed', 'compared', 'report_printed', 'result_saved')),
  key text not null default '',
  source jsonb not null default '{}'::jsonb,
  at timestamptz not null default app_now(),
  unique (visitor, stage, key)
);
create index funnel_events_at on funnel_events (at);

-- Leads: the adviser's override of the next best action, the first contact, and the outcome when closed.
alter table leads add column next_action_override text;
alter table leads add column next_action_reason text;
alter table leads add column next_action_by uuid references users(id);
alter table leads add column next_action_at timestamptz;
alter table leads add column first_contact_at timestamptz;
alter table leads add column closed_reason text;
alter table leads add column score_evidence jsonb;

grant select, insert, delete on funnel_events to app_platform;
grant usage, select on sequence funnel_events_id_seq to app_platform;
alter table funnel_events enable row level security;
create policy funnel_events_platform on funnel_events for all to app_platform using (true) with check (true);
