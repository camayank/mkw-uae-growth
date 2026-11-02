-- E3 Public display approvals: which rules and places a named person has approved for the public selector, once
-- per version. Additive.

create table public_approvals (
  id bigserial primary key,
  subject_kind text not null check (subject_kind in ('rule', 'place')),
  subject text not null,
  -- The version approved: a rule's version number, or the digest of a place's current figures and evidence. A new
  -- version never inherits an approval.
  version text not null,
  note text not null default '',
  approved_by uuid not null references users(id),
  approved_at timestamptz not null default app_now(),
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  revoke_note text not null default ''
);
create index public_approvals_subject on public_approvals (subject_kind, subject, id desc);
-- Exactly one live approval per subject, whatever two founders do at once.
create unique index public_approvals_live on public_approvals (subject_kind, subject) where revoked_at is null;

grant select, insert, update (revoked_by, revoked_at, revoke_note) on public_approvals to app_platform;
grant usage, select on sequence public_approvals_id_seq to app_platform;
alter table public_approvals enable row level security;
create policy public_approvals_platform on public_approvals for all to app_platform using (true) with check (true);
