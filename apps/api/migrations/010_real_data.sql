-- O10 Real data and staging: imported partners, legal texts with versions, invitations held until pilot.

-- A partner admin created by an import waits here until MKW moves the firm to pilot; until then the address
-- cannot request a sign-in code (auth only accepts 'active').
alter table users drop constraint users_status_check;
alter table users add constraint users_status_check check (status in ('active', 'deactivated', 'erased', 'invite_pending'));

-- Re-imports find a partner by the operating Sheet's Partner ID, never by name.
create unique index orgs_partner_source_id on orgs ((profile->>'sourceId')) where type = 'partner' and profile ? 'sourceId';

-- Client terms and the Partner Network Agreement, one row per version. The text is not confidential: clients
-- and partners read it before they accept. Only the platform writes; a lawyer's sign-off is recorded per version.
create table legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('client_terms', 'partner_agreement')),
  version int not null check (version > 0),
  title text not null,
  body text not null,
  body_sha256 text not null,
  created_at timestamptz not null default app_now(),
  approved_by_lawyer text,
  approved_on date,
  approved_recorded_by uuid references users(id),
  unique (kind, version)
);
grant all on legal_documents to app_platform;
grant select on legal_documents to app_client, app_partner;
alter table legal_documents enable row level security;
create policy legal_platform on legal_documents for all to app_platform using (true) with check (true);
create policy legal_read on legal_documents for select to app_client, app_partner using (true);

-- Which version of the client terms the client accepted with the offer.
alter table engagements add column client_terms_version int;
