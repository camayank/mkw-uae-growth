-- E22 (Codex review): a file the scan refuses must be replaceable, or the step and the payout it belongs to stay blocked
-- for good. A clean upload of the same kind supersedes the held one; the held file stays recorded and quarantined
-- (never served), and the audit trail says what replaced what.
alter table evidence add column superseded_at timestamptz, add column superseded_by uuid references evidence(id);
create index evidence_live on evidence (milestone_id) where superseded_at is null;

-- One live invoice per payout; superseded ones keep their row.
alter table partner_invoices add column superseded_at timestamptz, add column superseded_by uuid references partner_invoices(id);
alter table partner_invoices drop constraint partner_invoices_payout_id_key;
create unique index partner_invoices_live_payout on partner_invoices (payout_id) where superseded_at is null;
-- Partners read their own invoice rows by column grant (migration 005): the two new columns join in.
grant select (superseded_at, superseded_by) on partner_invoices to app_partner;
