#!/usr/bin/env bash
# Restore drill: prove a backup can be restored and that what comes back is whole.
#   DUMP         the .dump file from scripts/backup.sh (required)
#   ADMIN_URL    Postgres URL of a role that may CREATE DATABASE and CREATE ROLE on the drill server (required);
#                it needs CREATEROLE (or ADMIN OPTION on the app_* roles) to grant itself the three application roles
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
# Application-level check: start the compiled server on the restored copy, sign a client in with a one-time code
# and load their overview, so the restored grants and policies are proven to work rather than merely to exist.
port="${DRILL_PORT:-8799}"
( cd "$here/../apps/api" && DATABASE_URL="$target" DEV_LOGIN=1 PORT="$port" LOG=0 IN_PROCESS_JOBS=0 node --conditions=production dist/main.js >/dev/null 2>&1 & echo $! > "/tmp/tasees-drill.pid" )
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break; sleep 1; done
client_email="$(psql "$target" -At -c "select email from users where role = 'client_owner' and status = 'active' order by created_at limit 1")"
if [ -n "$client_email" ]; then
  code="$(curl -s -XPOST "http://127.0.0.1:$port/api/auth/request-code" -H 'content-type: application/json' -d "{\"email\":\"$client_email\"}" | sed -n 's/.*"devCode":"\([0-9]*\)".*/\1/p')"
  token="$(curl -s -XPOST "http://127.0.0.1:$port/api/auth/verify" -H 'content-type: application/json' -d "{\"email\":\"$client_email\",\"code\":\"$code\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  home="$(curl -s "http://127.0.0.1:$port/api/client/home" -H "authorization: Bearer $token")"
  if echo "$home" | grep -q '"engagements"' && ! echo "$home" | grep -qi 'margin\|partner_unit\|partnerUnit'; then
    echo "client sign-in on the restored copy: OK ($client_email loaded $(echo "$home" | grep -o '"id"' | wc -l) rows, no margin or partner cost field)"
  else
    echo "client sign-in on the restored copy: FAILED"; status=1
  fi
else
  echo "client sign-in on the restored copy: skipped (no active client owner in the backup)"
fi
kill -TERM "$(cat /tmp/tasees-drill.pid)" 2>/dev/null; sleep 2
last="$(psql "$target" -At -c "select max(at) from audit_events")"
echo "latest audit event in the backup: $last"
echo "== result: $([ $status -eq 0 ] && echo PASS || echo FAIL)"
exit $status
