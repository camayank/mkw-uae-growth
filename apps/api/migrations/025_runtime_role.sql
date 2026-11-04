-- E19: the application logs in as a role that owns nothing. Until now staging logged in as the database's master user,
-- which owns every table, so a compromised process could leave the per-request role (RESET ROLE), read anything,
-- disable a trigger or edit the audit trail. `app_runtime` is the group a runtime login joins: it has no privilege of
-- its own (NOINHERIT) and may only SET ROLE to the three application roles, as `asUser` and `asPlatform` already do. The
-- login itself is created by the migration step from a secret (`scripts/migrate.ts`, `ensureRuntimeLogin`), never here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then create role app_runtime nologin noinherit; end if;
end $$;
-- The group may switch to each role but never holds its rights (E19 review). PostgreSQL 16 decides inheritance per
-- grant, so the grant says so; PostgreSQL 15 has no per-grant options and decides by the member's NOINHERIT attribute,
-- which is set here too whatever the group was created with (Codex review of E19).
alter role app_runtime noinherit;
do $$
begin
  if current_setting('server_version_num')::int >= 160000 then
    -- As a string, so PostgreSQL 15 never parses the 16-only options.
    execute 'grant app_client, app_partner, app_platform to app_runtime with inherit false, set true';
  else
    grant app_client, app_partner, app_platform to app_runtime;
  end if;
end $$;
grant usage on schema public to app_runtime;

-- The audit trail is append-only at the database (CLAUDE.md rule 8). Events are written only through `audit_append`
-- (security definer); no application role may update, delete or truncate them, and the trigger refuses it even for a
-- role granted the privilege later. The owner can still disable the trigger, which is why the application never logs
-- in as the owner (above) and the nightly check also compares the chain's length.
revoke update, delete, truncate on audit_events from app_platform, app_client, app_partner;
create function audit_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'The audit trail is append-only: events are never changed or removed (E19, rule 8)';
end $$;
create trigger audit_events_no_change before update or delete on audit_events for each row execute function audit_events_append_only();
create trigger audit_events_no_truncate before truncate on audit_events for each statement execute function audit_events_append_only();

-- The runtime login checks at start that the schema is current, so the group may read the migration list.
grant select on schema_migrations to app_runtime;
