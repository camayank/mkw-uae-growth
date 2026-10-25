-- O13 Observability and hardening.

-- Each scheduled jobs run: when it started and ended, how each step went. One run at a time: a second run while one
-- is 'running' cannot insert its row (the unique index) and is skipped; a run that died is closed after 30 minutes.
create table job_runs (
  id bigserial primary key,
  job text not null default 'sweeps',
  status text not null default 'running' check (status in ('running', 'ok', 'failed', 'abandoned')),
  started_at timestamptz not null default app_now(),
  finished_at timestamptz,
  duration_ms int,
  -- { step: { ms, count, error? } }, in the order the steps ran.
  steps jsonb not null default '{}'::jsonb,
  error text
);
create unique index job_runs_one_running on job_runs (job) where status = 'running';
create index job_runs_recent on job_runs (job, started_at desc);
grant all on job_runs to app_platform;
grant usage on sequence job_runs_id_seq to app_platform;
alter table job_runs enable row level security;
create policy job_runs_platform on job_runs for all to app_platform using (true) with check (true);

-- Alerts about the platform itself (never about a client or a partner): one open alert per kind and subject.
create table alerts (
  id bigserial primary key,
  kind text not null check (kind in ('jobs_late', 'job_step_failed', 'outbox_stuck', 'audit_chain')),
  subject text not null default '',
  severity text not null default 'warning' check (severity in ('warning', 'critical')),
  summary text not null,
  opened_at timestamptz not null default app_now(),
  last_notified_at timestamptz,
  closed_at timestamptz
);
create unique index alerts_one_open on alerts (kind, subject) where closed_at is null;
grant all on alerts to app_platform;
grant usage on sequence alerts_id_seq to app_platform;
alter table alerts enable row level security;
create policy alerts_platform on alerts for all to app_platform using (true) with check (true);

-- The nightly audit chain check: one row per Dubai day.
create table audit_checks (
  day date primary key,
  checked bigint not null,
  broken_id bigint,
  at timestamptz not null default app_now()
);
grant all on audit_checks to app_platform;
alter table audit_checks enable row level security;
create policy audit_checks_platform on audit_checks for all to app_platform using (true) with check (true);

-- Idempotency keys: the first answer to a change, kept 24 hours for the person who made it.
create table idempotency_keys (
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  method text not null,
  path text not null,
  body_hash text not null,
  state text not null default 'running' check (state in ('running', 'done')),
  status_code int,
  response text,
  created_at timestamptz not null default app_now(),
  primary key (user_id, key)
);
create index idempotency_keys_age on idempotency_keys (created_at);
grant all on idempotency_keys to app_platform;
alter table idempotency_keys enable row level security;
create policy idempotency_keys_platform on idempotency_keys for all to app_platform using (true) with check (true);
