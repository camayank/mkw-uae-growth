-- E21: the audit trail is written only through audit_append, the nightly check only by the database, and every status
-- column holds only its machine's statuses.

-- 1. Audit events (S6, gap 148). Migration 001 granted app_platform every privilege on every table, so the platform
--    role could insert an event directly, with any link, hash or time: a malformed one breaks the chain for good. Every
--    application role appends through `audit_append` (security definer, owned by the migration login), which takes the
--    time and computes the link and the hash itself; none may insert, and none may take or move the event ids.
--    Migration 025's comment said this was already so; it was not. `audit_append` still takes the actor from its
--    caller, so a compromised application process can append a well-formed event naming any actor (gap 151).
revoke insert on audit_events from app_platform, app_client, app_partner;
revoke all on sequence audit_events_id_seq from app_platform, app_client, app_partner;
-- The platform reads the trail; it writes nothing to it but through the function. The policy said "for all".
drop policy audit_events_platform on audit_events;
create policy audit_events_platform on audit_events for select to app_platform using (true);
-- Only the table's owner inserts: inside `audit_append` the current user is the function's owner, who owns the table
-- (both are created by the migration login). Any other role is refused, whatever it was granted later: a broad "grant
-- all on all tables", as migration 001 did, a grant to PUBLIC, or one to the runtime login itself (E21 review).
create function app_is_table_owner(t oid) returns boolean language sql stable as $$
  select current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = t)
$$;
create function audit_events_insert_guard() returns trigger language plpgsql as $$
begin
  if not app_is_table_owner(tg_relid) then
    raise exception 'Audit events are written only through audit_append (E21, rule 8)';
  end if;
  return new;
end $$;
create trigger audit_events_insert_only_by_append before insert on audit_events for each row execute function audit_events_insert_guard();

-- 2. The nightly check (S4, S6, gaps 143 and 148). Its rows were writable by the platform: a forged "intact" row for
--    a future day would skip that day's check, and a broken one could be deleted. Now the database records the check
--    itself, from its own reading of the chain, and nobody but the owner changes or removes a row.
--    The check also compares the chain with the night before. It keeps the last event it saw (id and hash): if that
--    event is gone or different the next night, the tail was removed or rewritten, even when new events have made the
--    chain longer again. A row from before E21 has no last event, so the length alone is compared with it. A finding
--    stays alerted until the founder records the investigation (audit_check_reviews, below).
alter table audit_checks
  add column last_id bigint,
  add column last_hash text,
  add column finding text check (finding in ('changed', 'tail_removed', 'shortened'));
update audit_checks set finding = 'changed' where broken_id is not null;

revoke insert, update, delete, truncate on audit_checks from app_platform, app_client, app_partner;
drop policy audit_checks_platform on audit_checks;
create policy audit_checks_platform on audit_checks for select to app_platform using (true);

create function audit_checks_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not app_is_table_owner(tg_relid) then
      raise exception 'Audit checks are recorded only by audit_check_run (E21, rule 8)';
    end if;
    return new;
  end if;
  raise exception 'Audit checks are append-only: a check is never changed or removed (E21, rule 8)';
end $$;
create trigger audit_checks_no_insert before insert on audit_checks for each row execute function audit_checks_append_only();
create trigger audit_checks_no_change before update or delete on audit_checks for each row execute function audit_checks_append_only();
create trigger audit_checks_no_truncate before truncate on audit_checks for each statement execute function audit_checks_append_only();

-- Once per Dubai day: verify the whole chain, compare it with the latest earlier check, and record the result. Returns
-- the events checked, or 0 (recorded = false) when today's check, or a later one, is already recorded. A check is never
-- recorded for a day before the latest one, and its time is the database's real clock (E21 review): the history shows
-- only checks that ran, when they ran.
create function audit_check_run() returns table (checked bigint, broken_id bigint, finding text, recorded boolean)
language plpgsql security definer set search_path = public, pg_temp set timezone to 'UTC' set datestyle to 'ISO, MDY' as $$
declare
  -- The test clock (app.now) is a session setting any role may set: never later than the real clock, so nobody records
  -- tomorrow's check today and so skips it.
  v_day date := (least(app_now(), now()) at time zone 'Asia/Dubai')::date;
  v_checked bigint;
  v_broken bigint;
  v_last_id bigint;
  v_last_hash text;
  v_finding text;
  v_prev record;
begin
  perform pg_advisory_xact_lock(777010); -- two job runners record one check (an id no other lock uses)
  if exists (select 1 from audit_checks c where c.day >= v_day) then
    return query select 0::bigint, null::bigint, null::text, false;
    return;
  end if;
  select v.checked, v.broken_id into v_checked, v_broken from audit_verify() v;
  select e.id, e.hash into v_last_id, v_last_hash from audit_events e order by e.id desc limit 1;
  select c.day, c.checked, c.last_id, c.last_hash into v_prev from audit_checks c where c.day < v_day order by c.day desc limit 1;
  if v_broken is not null then
    v_finding := 'changed';
  elsif v_prev.last_id is not null and not exists (select 1 from audit_events e where e.id = v_prev.last_id and e.hash = v_prev.last_hash) then
    v_finding := 'tail_removed';
  elsif v_prev.day is not null and v_checked < v_prev.checked then
    v_finding := 'shortened';
  end if;
  insert into audit_checks (day, checked, broken_id, last_id, last_hash, finding, at)
  values (v_day, v_checked, v_broken, v_last_id, v_last_hash, v_finding, now());
  return query select v_checked, v_broken, v_finding, true;
end $$;
revoke all on function audit_check_run() from public;
grant execute on function audit_check_run() to app_platform;

-- A finding stays alerted until a person records that it was investigated (E21 review: a removed tail was found once,
-- and the next night's check, comparing with the already-shortened trail, found nothing and closed the alert). The
-- review is append-only: written once, never changed or removed. An edited event is found again every night until the
-- trail is restored, so its alert reopens with the next check.
create table audit_check_reviews (
  day date primary key references audit_checks(day),
  reviewed_by uuid not null references users(id),
  note text not null check (length(note) between 10 and 2000),
  at timestamptz not null default now()
);
grant select, insert on audit_check_reviews to app_platform;
alter table audit_check_reviews enable row level security;
create policy audit_check_reviews_read on audit_check_reviews for select to app_platform using (true);
create policy audit_check_reviews_add on audit_check_reviews for insert to app_platform with check (true);
create function append_only_refuse() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: a row is never changed or removed (E21, rule 8)', tg_table_name;
end $$;
create trigger audit_check_reviews_no_change before update or delete on audit_check_reviews for each row execute function append_only_refuse();
create trigger audit_check_reviews_no_truncate before truncate on audit_check_reviews for each statement execute function append_only_refuse();

-- 3. Status columns (S5, gap 146). Each holds only its machine's statuses (`STATUSES` in packages/core/src/states.ts;
--    `test/transitions.test.ts` compares the two). Payouts already had one.
alter table requests add constraint requests_status_check check (status in ('draft', 'scoped', 'quoting', 'offered', 'closed'));
alter table offers add constraint offers_status_check check (status in ('draft', 'ops_review', 'published', 'accepted', 'expired', 'withdrawn'));
alter table engagements add constraint engagements_status_check
  check (status in ('awaiting_payment', 'allocating', 'in_delivery', 'completed', 'cancelled', 'disputed'));
alter table milestones add constraint milestones_status_check
  check (status in ('pending', 'in_progress', 'evidence_submitted', 'qa_passed', 'qa_rejected', 'client_approved', 'disputed'));
alter table change_orders add constraint change_orders_status_check check (status in ('proposed', 'priced', 'approved', 'rejected'));
