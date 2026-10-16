#!/usr/bin/env bash
# Daily logical backup of the Tasees database.
#   DATABASE_URL   the live database (required)
#   BACKUP_DIR     where dumps are written (default ./backups)
#   BACKUP_BUCKET  optional: s3://bucket/prefix in a UAE region; the dump is copied there with the AWS CLI and
#                  server-side encryption, and dumps older than BACKUP_KEEP_DAYS (default 35) are removed locally.
# Managed Postgres (RDS, Azure Flexible Server) also takes its own automated snapshots with point-in-time recovery;
# this dump is the copy we can restore anywhere and the one the restore drill uses.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$BACKUP_DIR/tasees-$stamp.dump"
# --no-owner keeps the dump portable between hosts. Privileges (column grants, policies) ARE kept: the first
# restore drill showed that without them the application cannot read its own restored data.
pg_dump --format=custom --no-owner --file="$file" "$DATABASE_URL"
sha256sum "$file" > "$file.sha256"
echo "backup written: $file ($(du -h "$file" | cut -f1))"
if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$file" "$BACKUP_BUCKET/$(basename "$file")" --sse AES256 --only-show-errors
  aws s3 cp "$file.sha256" "$BACKUP_BUCKET/$(basename "$file").sha256" --sse AES256 --only-show-errors
  echo "copied to $BACKUP_BUCKET"
fi
find "$BACKUP_DIR" -name 'tasees-*.dump*' -mtime +"$KEEP_DAYS" -delete
