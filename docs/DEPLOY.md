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

Partner reply deadlines (4 working hours), client auto-approval (5 working days after MKW's check), offer
expiry (14 days), the licence watch, the delay watch, compliance reminders and the weekly (Monday) scorecard run every 15 minutes
in-process; the daily and weekly sweeps do nothing when already done for the day or week. With more than one instance, set `IN_PROCESS_JOBS=0` and run
`pnpm jobs` from one scheduler every 15 minutes. Each sweep is its own transaction and safe to repeat.

## First production setup

1. Run with `NODE_ENV=production`. Migrations and the catalogue load on start; demo data does not.
2. Create the first founder account once: `pnpm --filter @tasees/api create-founder connect@mkwadvisors.com "Full Name"`
   (idempotent; creates the MKW Advisors organisation if missing; sends nothing). Then sign in and create everything
   else from the **People** page: partner firms with their first admin, MKW staff, client users. Partner profiles
   (licence status, emirates, service codes, FTA/auditor approvals) are edited on the **Partners** page.
3. Load MKW's go-live data with the importers (below, "Go-live data"): partners, rate cards, government fees,
   holidays, company details, owner decisions and the two legal texts. Every importer is a dry run until `--apply`.
4. Email: create the SES identity for mkwadvisors.com in me-central-1, publish the SPF, DKIM and DMARC records it
   gives you, move the account out of the SES sandbox, verify both sender addresses, then set `EMAIL=ses`. Until
   then every message is still recorded in the delivery log (Settings page) and each person's bell.
   Connect the payment provider's webhook (O3).
5. Verify the government fee table and statutory notes with a qualified person before quoting real clients.
6. Confirm the retention periods on the **Settings** page after legal advice; until then they show as UNCERTAIN.
7. Take a first backup and run the restore drill against the new server; record it in `docs/RESTORE-DRILL.md`.

## Go-live data (O10)

The go-live files (`Tasees-Go-Live-Data.xlsx`, `Owner-Decisions.md`, `MKW-Company-Details.md`,
`Tasees-Client-Terms.md`, `MKW-Partner-Network-Agreement.md`) hold business contact details and MKW's commercial
terms. Keep them in `data/import/` (ignored by git) or in the private files bucket under `import/`; never commit them.

```bash
pnpm import all data/import                                   # dry run of everything, in order; writes nothing
pnpm import all data/import --as connect@mkwadvisors.com --apply
pnpm import partners data/import/Tasees-Go-Live-Data.xlsx     # one kind at a time
pnpm import fees data/import/Tasees-Go-Live-Data.xlsx --decisions data/import/Owner-Decisions.md
pnpm import:sheet rate-cards.csv                              # the Sheet's Rate Cards tab exported as CSV
pnpm import:dev ...                                           # the same, from the TypeScript sources (development)
```

- **Dry run first, always.** A dry run runs exactly the `--apply` code inside a transaction that is rolled back, so
  its report is what `--apply` will do. `--evidence docs/evidence/O10` also writes a copy with firm names and contact
  details removed.
- **Re-running changes nothing.** Rows already in the platform report as unchanged; each created or updated record
  writes one audit event. **Nobody is emailed or notified by an import.**
- **Partners** are created as prospects. An admin is added only when "Admin email" is filled, as `invite_pending`
  (no sign-in); MKW moving the firm to **pilot** sends the invitation. "FTA tax agent" is never set by an import.
  Once a firm is past `contacted`, the console is the record and the file no longer overwrites it.
- **Company details and decisions** apply through the founder's own Settings and Rules services, so `--as` must name
  a founder account; a blank answer changes nothing.
- **Legal texts** become a new version when the text changes, shown as "Draft, pending legal review" until the founder
  records the lawyer's review on Settings.

## Staging runbook (AWS me-central-1)

`infra/` describes staging and a separate demo as code (AWS CDK, TypeScript; `docs/DECISIONS.md` D44). Nothing in it
holds a secret: passwords and keys are generated into AWS Secrets Manager and read by the tasks at start.

| Stack | What it is |
| --- | --- |
| `TaseesStaging` | Real data. VPC (public, private, isolated subnets), RDS PostgreSQL 16 (encrypted, 30-day backups, deletion protection, isolated subnets), private encrypted versioned buckets for files and backups, the Dockerfile image on ECS Fargate behind an HTTPS load balancer (TLS 1.2+, HTTP redirects), `TRUST_PROXY=1`, `DEV_LOGIN` unset, the 15-minute jobs on an EventBridge schedule, alarms when jobs stop or the app is unhealthy. |
| `TaseesDemo` | Synthetic demo data only, for the browser smoke test: same image, embedded Postgres inside the task, development sign-in on, load balancer reachable only from one address range. No database, bucket or secret shared with staging. |

What the owner provides first (the "Ask me" items): an AWS account with access for the person deploying, the domain
and DNS (for example `app.tasees.ae` and `demo.tasees.ae`), an ACM certificate for those names in me-central-1, the
SES sender verification for mkwadvisors.com, and an email address for alarms. Staging costs money from the first
hour (RDS, NAT gateway, load balancers, Fargate); the owner approves the account and budget before step 2.

1. **Prepare.** Install Node 22, pnpm 10, Docker and the AWS CLI; sign in to the account (`aws sso login` or a named
   profile) with `AWS_REGION=me-central-1`. Request the certificate in ACM (me-central-1), validate it by DNS, note
   its ARN. Then:
   ```bash
   cd infra && pnpm install --ignore-workspace
   pnpm synth:check            # local check with example values; no AWS call
   npx cdk bootstrap aws://<account-id>/me-central-1
   ```
2. **Deploy staging.** Review the diff, then deploy (CDK builds the image from the repository's Dockerfile and pushes it):
   ```bash
   pnpm run diff -- TaseesStaging -c domainName=app.tasees.ae -c certificateArn=<arn> -c alarmEmail=<email>
   pnpm run deploy -- TaseesStaging -c domainName=app.tasees.ae -c certificateArn=<arn> -c alarmEmail=<email>
   ```
   Point the domain at the `LoadBalancerDns` output (CNAME or Route 53 alias). Confirm the alarm subscription email.
   The first task runs the migrations and loads the catalogue; no demo data is loaded (`NODE_ENV=production`).
   RDS's master user owns the database, so migration 001 can create its three roles on the first start.
3. **Check it.** `curl https://app.tasees.ae/api/health` answers `{"ok":true,"db":"postgres",...,"devLogin":false}`.
4. **Create the founder.** One-off task with the stack's outputs (`ClusterName`, `TaskDefinitionArn`, `TaskSubnets`,
   `TaskSecurityGroup`):
   ```bash
   aws ecs run-task --cluster <ClusterName> --task-definition <TaskDefinitionArn> --launch-type FARGATE \
     --network-configuration 'awsvpcConfiguration={subnets=[<subnet-a>,<subnet-b>],securityGroups=[<sg>],assignPublicIp=DISABLED}' \
     --overrides '{"containerOverrides":[{"name":"ScheduledContainer","command":["sh","-c","export DATABASE_URL=\"postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem\" && exec node --conditions=production dist/scripts/create-founder.js connect@mkwadvisors.com \"Full Name\""]}]}'
   ```
   The task's log (`JobLogs` group) prints what it did.
5. **Dry-run the go-live data on staging and show the owner.** Upload the five files to the files bucket under
   `import/` (`aws s3 cp data/import/ s3://<FilesBucket>/import/ --recursive --sse AES256`), then run a one-off task as
   in step 4, keeping the `export DATABASE_URL=... && exec` wrapper and replacing only the final command with
   `node --conditions=production dist/scripts/import.js all import/ --from-storage --as connect@mkwadvisors.com`.
   Send the owner the report from the task log. **Do not continue without the owner's go.**
6. **Apply.** The same task with `--apply` added. Run the same command again: every row must report unchanged. Then
   delete the files from the bucket (`aws s3 rm s3://<FilesBucket>/import/ --recursive`); the versioned copies expire
   after 35 days.
7. **Email.** In SES (me-central-1): verify the mkwadvisors.com domain, publish the DKIM, SPF and DMARC records, leave
   the sandbox, verify `tasees@mkwadvisors.com` and `partners@mkwadvisors.com`. Add a sending key to Secrets Manager,
   pass it as `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY`, set `EMAIL=ses` in `staging-stack.ts`, redeploy. Until then
   every message is recorded in the delivery log and the bell, and nothing leaves.
8. **Backups.** RDS snapshots run daily (30 days, point-in-time recovery). Also schedule `scripts/backup.sh` with
   `BACKUP_BUCKET=s3://<BackupsBucket>` and run the restore drill (`docs/RESTORE-DRILL.md`) against a scratch server.
9. **Demo and smoke test.** Deploy the demo with its own name and your office address range, then run the smoke test
   from that address against the demo, never against staging:
   ```bash
   pnpm run deploy -- TaseesDemo -c demoDomainName=demo.tasees.ae -c certificateArn=<arn> -c demoAllowedCidr=<office-ip>/32
   BASE_URL=https://demo.tasees.ae node scripts/smoke.mjs
   ```
   The demo task re-seeds synthetic data on every start; destroy it when not needed (`npx cdk destroy TaseesDemo`).

Undo: `npx cdk destroy TaseesDemo` removes the demo completely. Staging keeps its database (deletion protection, a
final snapshot), buckets and log groups on `cdk destroy`; removing those is a deliberate, separate step.
