# Restore drill

A backup is only a backup once it has been restored. This file records each drill: what was restored, how long
it took, and what was checked. Run the drill at least quarterly and after any change to the schema or the
backup scripts.

## How to run

```bash
# 1. Take a backup of the live database (daily, from cron or the host's scheduler)
DATABASE_URL=postgres://... BACKUP_DIR=./backups scripts/backup.sh
# 2. Restore it into a scratch database and verify
DUMP=./backups/tasees-YYYYMMDD-HHMMSS.dump ADMIN_URL=postgres://<role with CREATEDB>@... SOURCE_URL=$DATABASE_URL scripts/restore-drill.sh
```

The drill checks, in order: the dump's SHA-256 checksum; that the three application roles exist on the drill
server (they are cluster-wide and not part of a database dump); the restore itself; row counts of every
business table against the source; and the whole audit hash chain recomputed on the restored copy
(`pnpm verify:audit`). It drops the scratch database when it finishes and exits non-zero on any mismatch.

Managed Postgres (RDS, Azure Database for PostgreSQL) keeps its own automated snapshots with point-in-time
recovery for 30 days; the logical dump is the copy MKW can restore on any host, and it is the one this drill
exercises. Keep dumps in a bucket in the same UAE region as the database, with server-side encryption.

## Drill log

### 16 October 2026 · PostgreSQL 16.15 (local server) · PASS

Setup: the compiled build (`node --conditions=production dist/main.js`) ran against a fresh Postgres 16
database; `pnpm seed` loaded the demo parties and `scripts/smoke.mjs` drove one engagement end to end in
Chromium (request, offers, publish, accept, deposit, allocation to three partners, evidence, MKW check, client
approval), so the database held every kind of row the platform writes.

**First attempt: FAIL, and worth recording.** The first version of `backup.sh` used `pg_dump --no-privileges`.
Rows and the audit chain came back, but the restored database had none of the column grants or policies, so
`verify:audit` was refused with `permission denied for table audit_events`: the application could not have run
on that restore. The flag was removed from both scripts and the drill was rerun. This is the reason the drill
exists.

**Second attempt: PASS.**

```
backup written: backups/tasees-20261016-202538.dump (124K)
== restore drill 2026-10-16T20:25:38Z
dump: backups/tasees-20261016-202538.dump (124K)
backups/tasees-20261016-202538.dump: OK                                   (sha256 checksum)
restored in 0 s into tasees_restore_20261016_202538
restored counts: orgs=5 users=11 requests=1 offers=2 offer_lines=8 engagements=1 engagement_lines=4 allocations=3
                 milestones=10 evidence=1 messages=1 payments=2 payouts=9 change_orders=0 audit_events=17
                 data_requests=0 settings=2 schema_migrations=2
source counts:   (identical)
row counts: MATCH
-- audit chain on the restored database
Audit chain intact: 17 events verified.
audit chain: INTACT
latest audit event in the backup: 2026-10-16 20:25:05.933379+00
== result: PASS
scratch database dropped
```

Then, outside the script, the compiled server was started against a second restored copy. A client signed in
with a one-time code and loaded the overview: 1 engagement and 1 offer came back, and the response carried no
`margin` field. The grants and row-level security policies therefore work on the restore, not merely exist.

Recovery point: the backup held every event up to 20:25:05 UTC; it was taken at 20:25:38, so the data loss window
for a logical dump is the interval between dumps (daily by default). Point-in-time recovery on managed Postgres
narrows that to minutes; confirm it is switched on when the production database is created.

Not covered by this drill: object storage (evidence files) is versioned and replicated by the bucket, not by
`pg_dump`; a file-level restore test belongs to the first staging deployment once the bucket exists. Evidence
rows in the database reference files by key, so a database restore plus the bucket's own versioning restores
the pair.
