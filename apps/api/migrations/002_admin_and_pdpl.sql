-- O1 Production foundation: user lifecycle, PDPL data requests, retention settings.
-- Additive only: the previous code keeps running against this schema.

-- Users can be deactivated (no new sign-in codes, existing sessions revoked) and later erased (tombstoned).
alter table users add column status text not null default 'active'
  check (status in ('active', 'deactivated', 'erased'));
alter table users add column invited_by uuid references users(id);
alter table users add column deactivated_at timestamptz;
alter table users add column erased_at timestamptz;

grant select (status) on users to app_client, app_partner;

-- Every export or erasure request under the UAE PDPL is recorded, with who asked for it and what was done.
create table data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('export', 'erase')),
  requested_by uuid references users(id),
  status text not null default 'done' check (status in ('done', 'refused')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default app_now()
);
create index on data_requests (user_id);

grant all on data_requests to app_platform;
alter table data_requests enable row level security;
create policy data_requests_platform on data_requests for all to app_platform using (true) with check (true);

-- Retention periods. Each period carries its own confidence: UNCERTAIN until the founder confirms it after
-- legal advice. Nothing is deleted automatically by this version; the periods are recorded and displayed.
insert into settings (key, value) values ('retention', '{
  "confirmed": false,
  "confirmedBy": null,
  "confirmedAt": null,
  "periods": {
    "taxRecords":      {"years": 5,  "basis": "FTA record-keeping: 5 years after the end of the tax period (15 for real estate records)", "confidence": "UNCERTAIN"},
    "clientDocuments": {"years": 5,  "basis": "Kept 5 years after the engagement completes, in step with the tax records they support", "confidence": "UNCERTAIN"},
    "messages":        {"years": 5,  "basis": "Engagement correspondence kept with the engagement record", "confidence": "UNCERTAIN"},
    "auditTrail":      {"years": null, "basis": "Append-only hash chain; kept indefinitely so earlier records can be proven", "confidence": "UNCERTAIN"},
    "sessions":        {"days": 14, "basis": "Session life; expired rows are deleted on sweep", "confidence": "verified"},
    "loginCodes":      {"days": 1,  "basis": "Codes live 10 minutes; rows are deleted after a day", "confidence": "verified"}
  }
}'::jsonb) on conflict (key) do nothing;

-- Recompute every audit hash from the stored columns and report the first row that does not match.
-- Used by tests, the restore drill and `pnpm verify:audit`. The hash covers at::text, so the session must
-- use the same time zone as the writer; the application always sets UTC (see lib/db.ts).
create function audit_verify() returns table (checked bigint, broken_id bigint) language plpgsql stable as $$
declare
  r record;
  v_prev text := 'genesis';
  v_n bigint := 0;
  v_hash text;
begin
  for r in select * from audit_events order by id loop
    v_n := v_n + 1;
    if r.prev_hash <> v_prev then
      return query select v_n, r.id; return;
    end if;
    v_hash := encode(sha256(convert_to(
      r.prev_hash || '|' || r.at::text || '|' || coalesce(r.actor_user_id::text, '') || '|' || r.action || '|' || r.entity || '|' ||
      coalesce(r.entity_id, '') || '|' || coalesce(r.data::text, '{}'), 'UTF8')), 'hex');
    if v_hash <> r.hash then
      return query select v_n, r.id; return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select v_n, null::bigint;
end $$;

grant execute on function audit_verify() to app_platform;

-- The hash covers at::text. Pin the time zone and date style inside both functions so the text, and therefore
-- the hash, is the same whatever the session that writes or verifies has set. The formula is unchanged, so
-- every event already written under a UTC session still verifies.
alter function audit_append(uuid, uuid, text, text, text, jsonb) set timezone to 'UTC';
alter function audit_append(uuid, uuid, text, text, text, jsonb) set datestyle to 'ISO, MDY';
alter function audit_verify() set timezone to 'UTC';
alter function audit_verify() set datestyle to 'ISO, MDY';
