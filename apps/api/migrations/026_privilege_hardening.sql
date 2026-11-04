-- E19 (independent review): the application roles keep only what they use.
-- 1. Earlier migrations granted app_platform every privilege on every table, TRIGGER and REFERENCES included. With
--    TRIGGER, the runtime login could attach its own trigger to audit_events, which then ran as the owner inside the
--    security-definer `audit_append`, and from there switch the append-only guard off and rewrite the trail. No
--    application role creates triggers or foreign keys; both are revoked on every table. A test checks that no later
--    migration gives them back.
revoke trigger, references on all tables in schema public from app_platform, app_client, app_partner;
-- 2. The migration list is the migration step's: an application role could mark a future migration as applied (so it
--    is skipped) or delete one (so the step fails). The runtime group may only read it, to check the schema is current.
revoke all on schema_migrations from app_platform, app_client, app_partner;
-- 3. No temporary objects: they were the way to define code that the security-definer functions would find. PGlite (the
--    single-user embedded database of development and tests, built with Emscripten) has no database privileges to revoke.
do $$
begin
  if version() not like '%Emscripten%' then
    execute format('revoke temporary on database %I from public', current_database());
  end if;
end $$;
-- 4. Every security-definer function searches public, then the (now unusable) temporary schema last.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
  end loop;
end $$;
