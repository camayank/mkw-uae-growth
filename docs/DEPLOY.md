# Deploying

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | unset | Postgres connection string. Unset means embedded PGlite on disk (development only). |
| `PGLITE_DIR` | `./data/pglite` | Where PGlite keeps its files when `DATABASE_URL` is unset. |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in a container. |
| `NODE_ENV` | unset | Set to `production` in production. Disables demo seeding and development sign-in. |
| `DEV_LOGIN` | unset | `1` shows sign-in codes on screen and in API responses. Never set in production. |
| `PAYMENT_WEBHOOK_SECRET` | unset | Secret for the payment webhook signature: `x-webhook-signature: sha256=HMAC_SHA256(secret, "<x-webhook-timestamp>.<raw body>")`, five-minute window. Unset rejects all webhooks. |
| `TRUST_PROXY` | unset | Number of proxy hops in front of the API (`1` behind one load balancer). Unset, `X-Forwarded-For` is ignored and every visitor behind a proxy shares one rate-limit bucket; set it or the public intake page and sign-in throttle lock everyone out together. |
| `AI` | `memory` | Model behind the AI draft queue. Only the deterministic in-memory double exists until an API key and a monthly cap are agreed (`AI=anthropic` is reserved for it). |
| `PAYMENT` | `memory` | Card payment provider. Only `memory` exists until the merchant account is chosen; its links lead to an explanatory page. |
| `STORAGE` | `local` | `s3` stores evidence files in an S3-compatible bucket (production); anything else uses local disk. |
| `S3_BUCKET` | unset | Bucket name. Required when `STORAGE=s3`. |
| `S3_REGION` | `me-central-1` | Region used in the request signature (AWS UAE). Other providers accept any value. |
| `S3_ENDPOINT` | AWS for the region | Service URL for a non-AWS S3-compatible store, for example `https://objects.example.ae`. Path-style addressing is used when set. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset | Credentials of a user allowed only `s3:PutObject` and `s3:GetObject` on the bucket. Required when `STORAGE=s3`. |
| `S3_SESSION_TOKEN` | unset | Optional, for temporary credentials. |
| `S3_PREFIX` | empty | Key prefix inside the bucket, for example `evidence/`. |
| `S3_SSE` | `AES256` | Server-side encryption asked for on every upload; `aws:kms` with `S3_KMS_KEY_ID` to use a customer key. |
| `S3_FORCE_PATH_STYLE` | by endpoint | `1` or `0` to override the addressing style. |
| `UPLOAD_DIR` | `./data/uploads` | Where evidence files are stored with the local disk adapter. |
| `EMAIL` | `console` | `ses` sends email through Amazon SES; anything else records and prints each message. |
| `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | fall back to the `S3_*` values | Credentials of a user allowed only `ses:SendEmail`. `SES_ENDPOINT` overrides the service URL. |
| `EMAIL_FROM_CLIENT` | `tasees@mkwadvisors.com` | Sender address for messages to clients (shown as "Tasees, by MKW Advisors"). Must be verified in SES. |
| `EMAIL_FROM_PARTNER` | `partners@mkwadvisors.com` | Sender address for messages to partners and staff (shown as "MKW Advisors"). |
| `APP_URL` | `http://localhost:PORT` | Public URL of the workspace, used in links inside messages. |
| `WEB_DIR` | `apps/web/public` | Static web app served at `/`. |
| `IN_PROCESS_JOBS` | on | `0` turns off the 15-minute in-process timers; then run `pnpm jobs` from cron. |
| `LOG` | on | `0` turns off request logging. |

Copy `.env.example` and fill it in. Nothing reads `.env` automatically; export the variables or use your host's
secret store.

## Postgres

Any Postgres 15+ works; the test suite runs on PostgreSQL 16 as well as PGlite (`TEST_DATABASE_URL=... pnpm test`).

One-off DBA step on managed Postgres: the first migration creates three cluster-wide roles (`app_client`,
`app_partner`, `app_platform`) and grants them to the connecting user, so that user needs `CREATEROLE` the first
time migrations run. If the application user may not have `CREATEROLE`, a DBA runs the `do $$ ... $$` block and the
`grant ... to <app user>` line at the top of `apps/api/migrations/001_init.sql` once, before the first start. The
same block is needed on any server a backup is restored to (`scripts/restore-drill.sh` does it). Migrations run
automatically on start and are recorded in `schema_migrations`.

The audit hash covers each event's time stamp as text; the `audit_append` and `audit_verify` functions pin their
own time zone and date style, so the chain verifies whatever the server or a DBA session has set.

Data residency: client documents and personal data fall under the UAE PDPL. Host the database and file storage
in a UAE region (for example Azure UAE North, AWS me-central-1, Oracle Cloud Dubai or a UAE provider such as
G42/Core42) unless your lawyer confirms another location is acceptable.

Backups: switch on the host's automated snapshots with point-in-time recovery (kept at least 30 days) **and** run
`scripts/backup.sh` daily (`pg_dump`, custom format, checksummed, copied to a bucket in the same UAE region with
`BACKUP_BUCKET=s3://...`). Prove each backup with `scripts/restore-drill.sh` at least quarterly and record the
result in `docs/RESTORE-DRILL.md`. `pnpm verify:audit` recomputes the whole audit hash chain on any database and
is safe to run at any time. The audit table is append-only by design; never truncate it.

## Running

Production runs the compiled JavaScript (`pnpm build` → `packages/core/dist`, `apps/api/dist`) under plain Node 22;
no TypeScript loader is installed in the image. `--conditions=production` makes Node pick the compiled `@tasees/core`;
`pnpm start`, `pnpm jobs`, `pnpm import:sheet`, `pnpm verify:audit` and the Dockerfile all set it.

```bash
pnpm install --frozen-lockfile
pnpm build
NODE_ENV=production DATABASE_URL=... STORAGE=s3 S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  PAYMENT_WEBHOOK_SECRET=... HOST=0.0.0.0 pnpm start
```

The `Dockerfile` is a two-stage build: the first stage compiles, the second installs production dependencies
only and copies the compiled output, the migrations and the web app. It runs as the unprivileged `node` user,
answers `HEALTHCHECK` on `/api/health` and shuts down cleanly on `SIGTERM` (in-flight requests finish, the
database closes). Without `DATABASE_URL` it falls back to embedded PGlite under `/app/data`, which is for trying
the image, not for production.

```bash
docker build -t tasees-platform .
docker run -p 8787:8787 -e DATABASE_URL=... -e STORAGE=s3 -e S3_BUCKET=... -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  -e PAYMENT_WEBHOOK_SECRET=... tasees-platform
```

Continuous integration (`.github/workflows/ci.yml`) runs on every pull request: install, typecheck, the unit and
API tests, the compiled build, the browser smoke test against the compiled server (screenshots kept as an
artifact), the audit-chain verification of that run, and a build of the container image.

## Hosting in the UAE

The platform needs three managed pieces in a UAE region: Postgres, an S3-compatible bucket and a place to run the
container. Suggested: **AWS me-central-1 (UAE)** with RDS for PostgreSQL (automated backups and point-in-time
recovery on, `timezone` left at UTC), an S3 bucket with default encryption, versioning and a lifecycle rule, and
App Runner or ECS Fargate for the container behind HTTPS. Azure UAE North works for Postgres (Flexible Server) and
the container (Container Apps), but Azure Blob Storage does not speak the S3 API; use a UAE-region S3-compatible
store (for example Oracle Cloud Dubai object storage, or a MinIO gateway in front of Blob), unless your lawyer
confirms another location is acceptable. Either way, keep the backup bucket in the same region as the database.

Put it behind HTTPS (the host's load balancer or a reverse proxy) and set `TRUST_PROXY` to the number of
hops so rate limits see real client addresses. Session cookies are `Secure` when `DEV_LOGIN` is off, so
plain HTTP sign-in will not work in production, by design.

## Timers

Partner reply deadlines (4 working hours), client auto-approval (5 working days after MKW's check) and offer
expiry (14 days) run every 15 minutes in-process. With more than one instance, set `IN_PROCESS_JOBS=0` and run
`pnpm jobs` from one scheduler every 15 minutes. Each sweep is its own transaction and safe to repeat.

## First production setup

1. Run with `NODE_ENV=production`. Migrations and the catalogue load on start; demo data does not.
2. Create the first founder account by SQL once (`insert into orgs (type, name) values ('platform', 'MKW Advisors')`
   and a `users` row with role `founder`), then sign in and create everything else from the **People** page:
   partner firms with their first admin, MKW staff, client users. Partner profiles (licence status, emirates,
   service codes, FTA/auditor approvals) are edited on the **Partners** page.
3. Load rate cards: export the **Rate Cards** tab of the operating Google Sheet as CSV and run
   `pnpm import:sheet rate-cards.csv` (dry run), then again with `--apply`.
4. Email: create the SES identity for mkwadvisors.com in me-central-1, publish the SPF, DKIM and DMARC records it
   gives you, move the account out of the SES sandbox, verify both sender addresses, then set `EMAIL=ses`. Until
   then every message is still recorded in the delivery log (Settings page) and each person's bell.
   Connect the payment provider's webhook (O3).
5. Verify the government fee table and statutory notes with a qualified person before quoting real clients.
6. Confirm the retention periods on the **Settings** page after legal advice; until then they show as UNCERTAIN.
7. Take a first backup and run the restore drill against the new server; record it in `docs/RESTORE-DRILL.md`.
