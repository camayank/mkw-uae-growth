#!/usr/bin/env bash
# Restore drill: prove a backup can be restored and that what comes back is whole.
#   DUMP         the .dump file from scripts/backup.sh (required)
#   ADMIN_URL    Postgres URL of a role that may CREATE DATABASE on the drill server (required)
#   SOURCE_URL   optional: the live database, to compare row counts against
# Creates a scratch database, restores into it, verifies the checksum, recomputes the whole audit hash chain,
# compares row counts with the source when given, and drops the scratch database. Prints a log to copy into
# docs/RESTORE-DRILL.md. Exit code is non-zero if anything does not match.
set -euo pipefail
: "${DUMP:?set DUMP}"; : "${ADMIN_URL:?set ADMIN_URL}"
here="$(cd "$(dirname "$0")" && pwd)"
scratch="tasees_restore_$(date -u +%Y%m%d_%H%M%S)"
echo "== restore drill $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "dump: $DUMP ($(du -h "$DUMP" | cut -f1))"
if [ -f "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256"); fi
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "create database $scratch"
cleanup() { psql "$ADMIN_URL" -q -c "drop database if exists $scratch with (force)" >/dev/null; echo "scratch database dropped"; }
trap cleanup EXIT
target="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$ADMIN_URL" "$scratch")"
# The three application roles are cluster-wide and are not part of a database dump. A drill (or disaster) server
# needs them before the grants in the dump can be replayed; this is the same block as migration 001.
psql "$target" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_client') then create role app_client nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_partner') then create role app_partner nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_platform') then create role app_platform nologin; end if;
end $$;
grant app_client, app_partner, app_platform to current_user;
SQL
start=$(date +%s)
pg_restore --no-owner --dbname="$target" "$DUMP"
echo "restored in $(( $(date +%s) - start )) s into $scratch"
TABLES="orgs users requests offers offer_lines engagements engagement_lines allocations milestones evidence messages payments payouts change_orders audit_events data_requests settings schema_migrations"
counts() { for t in $TABLES; do printf '%s=%s ' "$t" "$(psql "$1" -At -c "select count(*) from $t")"; done; echo; }
restored="$(counts "$target")"
echo "restored counts: $restored"
status=0
if [ -n "${SOURCE_URL:-}" ]; then
  source="$(counts "$SOURCE_URL")"
  echo "source counts:   $source"
  if [ "$source" = "$restored" ]; then echo "row counts: MATCH"; else echo "row counts: DIFFER"; status=1; fi
fi
echo "-- audit chain on the restored database"
if (cd "$here/../apps/api" && DATABASE_URL="$target" node --conditions=production dist/scripts/verify-audit.js); then
  echo "audit chain: INTACT"
else
  echo "audit chain: BROKEN"; status=1
fi
last="$(psql "$target" -At -c "select max(at) from audit_events")"
echo "latest audit event in the backup: $last"
echo "== result: $([ $status -eq 0 ] && echo PASS || echo FAIL)"
exit $status
