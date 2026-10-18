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
| `PAYMENT_WEBHOOK_SECRET` | unset | Shared secret the payment provider (or your integration) sends in `x-webhook-secret`. Unset rejects all webhooks. |
| `UPLOAD_DIR` | `./data/uploads` | Where evidence files are stored (local disk adapter). |
| `WEB_DIR` | `apps/web/public` | Static web app served at `/`. |
| `IN_PROCESS_JOBS` | on | `0` turns off the 15-minute in-process timers; then run `pnpm jobs` from cron. |
| `LOG` | on | `0` turns off request logging. |

Copy `.env.example` and fill it in. Nothing reads `.env` automatically; export the variables or use your host's
secret store.

## Postgres

Any Postgres 15+ works. The first migration creates three roles (`app_client`, `app_partner`, `app_platform`)
and grants them to the connecting user, so that user needs `CREATEROLE` the first time migrations run (or a DBA
runs `apps/api/migrations/001_init.sql` once). Migrations run automatically on start and are recorded in
`schema_migrations`.

Data residency: client documents and personal data fall under the UAE PDPL. Host the database and file storage
in a UAE region (for example Azure UAE North, AWS me-central-1, Oracle Cloud Dubai or a UAE provider such as
G42/Core42) unless your lawyer confirms another location is acceptable.

Backups: daily automated backups with point-in-time recovery, kept at least 30 days. The audit table is
append-only by design; never truncate it.

## Running

```bash
pnpm install --frozen-lockfile
NODE_ENV=production DATABASE_URL=... PAYMENT_WEBHOOK_SECRET=... HOST=0.0.0.0 pnpm start
```

A `Dockerfile` is included. It runs the TypeScript directly with `tsx`, which is simple and fine at this scale;
compile with `tsc` later if start-up time matters.

```bash
docker build -t tasees-platform .
docker run -p 8787:8787 -e DATABASE_URL=... -e PAYMENT_WEBHOOK_SECRET=... -v tasees-uploads:/app/data/uploads tasees-platform
```

Put it behind HTTPS (the host's load balancer or a reverse proxy). Session cookies are `Secure` when
`DEV_LOGIN` is off, so plain HTTP sign-in will not work in production, by design.

## Timers

Partner reply deadlines (4 working hours), client auto-approval (5 working days after MKW's check) and offer
expiry (14 days) run every 15 minutes in-process. With more than one instance, set `IN_PROCESS_JOBS=0` and run
`pnpm jobs` from one scheduler every 15 minutes. Each sweep is its own transaction and safe to repeat.

## First production setup

1. Run with `NODE_ENV=production`. Migrations and the catalogue load on start; demo data does not.
2. Create the MKW Advisors platform users and partner organisations (today by SQL; see KNOWN-GAPS for the
   admin screens). Partner profiles hold licence status, emirates, service codes and FTA/auditor approvals.
3. Load rate cards: export the **Rate Cards** tab of the operating Google Sheet as CSV and run
   `pnpm import:sheet rate-cards.csv` (dry run), then again with `--apply`.
4. Replace the console notifier with a real email provider and connect the payment provider's webhook.
5. Verify the government fee table and statutory notes with a qualified person before quoting real clients.
