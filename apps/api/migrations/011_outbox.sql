-- O11 Ops command centre and event outbox.

-- Every side effect leaves through here: written in the same transaction as the change that causes it, delivered
-- afterwards by the dispatcher (src/lib/outbox.ts). A row is claimed before delivery; a claim that never finished
-- becomes 'unknown' and waits for a person, so nothing is ever sent twice on its own.
create table outbox (
  id bigserial primary key,
  topic text not null check (topic in ('notify', 'document_check')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'done', 'failed', 'unknown', 'cancelled')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default app_now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default app_now(),
  done_at timestamptz,
  resolved_by uuid references users(id),
  resolution text
);
create index outbox_due on outbox (next_attempt_at) where status = 'pending';
create index outbox_attention on outbox (status) where status in ('failed', 'unknown', 'sending');

grant all on outbox to app_platform;
grant usage on sequence outbox_id_seq to app_platform, app_client, app_partner;
-- A change made under a client's or partner's own database role may raise a message; it can add the row and
-- nothing else (no reading, so a payload with a price is never visible to the other side).
grant insert on outbox to app_client, app_partner;
alter table outbox enable row level security;
create policy outbox_platform on outbox for all to app_platform using (true) with check (true);
create policy outbox_insert on outbox for insert to app_client, app_partner with check (status = 'pending' and attempts = 0);

-- One notifications record per outbox row, however many times the dispatcher looks at it.
alter table notifications add column outbox_id bigint unique references outbox(id);

-- The document checker's drafts: what was checked, for which upload.
alter table ai_drafts drop constraint ai_drafts_kind_check;
alter table ai_drafts add constraint ai_drafts_kind_check check (kind in ('scope', 'quote_chaser', 'risk_flag', 'document_check'));
alter table ai_drafts add column subject_type text check (subject_type in ('evidence', 'document_request', 'partner_document', 'obligation'));
alter table ai_drafts add column subject_id uuid;
create index ai_drafts_subject on ai_drafts (subject_type, subject_id);

-- Queue timings: when a person opened an item from the queue and when it left the queue.
create table queue_timings (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref text not null,
  engagement_id uuid references engagements(id),
  item_at timestamptz not null,
  opened_by uuid references users(id),
  opened_at timestamptz,
  resolved_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default app_now()
);
-- One open record per item: a second open keeps the first time.
create unique index queue_timings_open on queue_timings (kind, ref) where resolved_at is null;
create index queue_timings_resolved on queue_timings (resolved_at);
grant all on queue_timings to app_platform;
alter table queue_timings enable row level security;
create policy queue_timings_platform on queue_timings for all to app_platform using (true) with check (true);

-- When the partner first handed the step in, on the application clock (resubmissions after a QA rejection keep the
-- first time). "On time" compares this with the due date in Dubai; it was read from the audit trail's wall clock,
-- which disagreed with due dates set on a test or replay clock. Existing steps take the time from the audit trail.
alter table milestones add column first_submitted_at timestamptz;
update milestones m set first_submitted_at = (
  select min(a.at) from audit_events a where a.entity = 'milestone' and a.entity_id = m.id::text and a.action = 'milestone.submitted'
);

-- When a payout became eligible, so the queue can say how long it has waited (earlier ones show from now).
alter table payouts add column eligible_at timestamptz;
