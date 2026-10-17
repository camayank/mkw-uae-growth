-- O2 Notifications: a record of every message the platform raises, which doubles as each user's in-app bell.

create function app_user() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  to_email text not null,
  channel text not null check (channel in ('email', 'whatsapp')),
  template text not null,
  audience text not null check (audience in ('client', 'partner', 'staff')),
  subject text not null,
  body text not null,
  vars jsonb not null default '{}'::jsonb,
  -- Shown in the recipient's bell. Sign-in codes are email-only.
  in_app boolean not null default true,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_ref text,
  error text,
  created_at timestamptz not null default app_now(),
  sent_at timestamptz,
  read_at timestamptz
);
create index on notifications (user_id, created_at desc);
create index on notifications (template, created_at desc);

grant all on notifications to app_platform;
-- A person sees only their own in-app rows, and never the delivery internals (vars, error, provider reference).
grant select (id, user_id, template, subject, body, in_app, status, created_at, read_at) on notifications to app_client, app_partner;
alter table notifications enable row level security;
create policy notifications_platform on notifications for all to app_platform using (true) with check (true);
create policy notifications_own on notifications for select to app_client, app_partner using (user_id = app_user() and in_app);
