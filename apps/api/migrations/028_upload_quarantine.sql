-- E22: every uploaded file is held until a malware scan finds it clean (CLAUDE.md rules 5 and 7; gap 45; T6).
-- One row per stored upload: what its bytes are, its size and hash, who sent it, and its scan status. The status is the
-- seventh machine (`file` in packages/core/src/states.ts): after the upload it moves only through `transition()`,
-- each move audited. MKW's own generated files (invoice PDFs, the payout bank file) are not uploads and have no row.
create table file_scans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  file_name text not null,
  detected_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  uploaded_by uuid references users(id),
  -- pending: no scanner has looked at it; clean / infected: a scanner's verdict; failed: the scan could not be done;
  -- not_scanned: no scanner, and the owner chose to serve unscanned files, labelled (T6, UPLOADS_UNSCANNED=allow).
  status text not null check (status in ('pending', 'clean', 'infected', 'failed', 'not_scanned')),
  scanner text,
  finding text,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default app_now(),
  scanned_at timestamptz
);
create index file_scans_held on file_scans (created_at) where status in ('pending', 'failed', 'not_scanned');

grant select, insert, update on file_scans to app_platform;
alter table file_scans enable row level security;
create policy file_scans_platform on file_scans for all to app_platform using (true) with check (true);
-- The record of what was held and why stays: rows are never removed (erasure clears the file name only).
create trigger file_scans_no_delete before delete on file_scans for each row execute function append_only_refuse();
create trigger file_scans_no_truncate before truncate on file_scans for each statement execute function append_only_refuse();

-- Clients and partners never read the table, nor the storage keys (column grants keep `file_key` from clients). This
-- function gives a file's scan status only, by the row that names it: an evidence, a client document, a partner
-- document or an obligation. A status is all it returns, for a row id the caller already holds.
create function file_scan_status(p_kind text, p_id uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select s.status from file_scans s where s.key = case p_kind
    when 'evidence' then (select e.file_key from evidence e where e.id = p_id)
    when 'document_request' then (select d.file_key from document_requests d where d.id = p_id)
    when 'partner_document' then (select pd.file_key from partner_documents pd where pd.id = p_id)
    when 'obligation' then (select o.evidence_key from obligations o where o.id = p_id)
  end
$$;
revoke all on function file_scan_status(text, uuid) from public;
grant execute on function file_scan_status(text, uuid) to app_client, app_partner, app_platform;

-- Files stored before E22 were never scanned: they are held until the jobs step scans them (a missing scan is not
-- clean). Staging and production hold none today.
insert into file_scans (key, file_name, detected_type, size_bytes, sha256, uploaded_by, status)
select file_key, file_name, 'unknown', 0, '', uploaded_by, 'pending' from evidence
union all select file_key, file_name, 'unknown', 0, '', uploaded_by, 'pending' from partner_documents
union all select file_key, file_name, 'unknown', 0, '', uploaded_by, 'pending' from document_requests where file_key is not null
union all select evidence_key, coalesce(evidence_name, ''), 'unknown', 0, '', evidence_uploaded_by, 'pending' from obligations where evidence_key is not null
union all select file_key, file_name, 'unknown', 0, '', uploaded_by, 'pending' from partner_invoices
on conflict (key) do nothing;

-- A held upload (infected, or a scan that keeps failing) is a platform alert of its own kind.
alter table alerts drop constraint alerts_kind_check;
alter table alerts add constraint alerts_kind_check check (kind in ('jobs_late', 'job_step_failed', 'outbox_stuck', 'audit_chain', 'upload_held'));
