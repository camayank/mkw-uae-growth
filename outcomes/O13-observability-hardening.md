# O13 Observability and hardening

Status: in-progress (branch `outcome/O13-observability-hardening` from `main` after O12 merged as
camayank/mkw-uae-growth#13; released by the owner 25 Oct 2026)

## Business result

Nothing fails silently, and a retry never double-creates. Every log line says who and which request; a job that did
not run, a step that failed, a message stuck in the outbox or a broken audit chain raises an alert to a person within
the hour. Pressing a button twice, or a network retry, gives the same result as pressing it once. The platform refuses
to start with a configuration that would misbehave, and its interface is a written contract that tests keep honest.

## Scope

1. **Validated configuration at boot.** `lib/config.ts` declares every environment variable the API reads, with its
   type and rules. The server, the jobs runner and the scripts check it before anything else and refuse to start with
   a list of every problem (names and the rule broken, never the values). In production: a webhook secret of at least
   16 characters; `EMAIL=ses` needs its region and both senders; `STORAGE=s3` needs its bucket and region;
   `DEV_LOGIN=1` is refused rather than silently ignored; `APP_URL` must be https. The warnings that are fine for one
   instance stay warnings.
2. **Structured logs.** One JSON line per request with a request id (taken from a well-formed `x-request-id` from the
   load balancer, otherwise made here), returned as `x-request-id`; after sign-in, the person's user id, organisation
   and role on every line of that request (ids only: no email, name, body, cookie or token). A server error answers
   with its request id so a person can quote it. Each jobs run logs one line per step with its duration and count.
3. **Job runs, metrics and alerts.** Migration `012_hardening.sql` adds `job_runs` (each run and each step: start,
   end, duration, count, error) and `alerts` (kind, subject, opened, last notified, closed).
   - Only one jobs run at a time: a second run while one is in progress is skipped and recorded, and a run that died
     is closed after 30 minutes.
   - A watchdog in the server checks every five minutes. It opens an alert when the jobs have not completed for 45
     minutes, when a step failed in the last run, when a message has waited in the outbox for more than 30 minutes, or
     when the audit chain check failed. Each alert is emailed through the outbox to `ALERT_EMAIL` when it opens, again
     every four hours while open, and once when it clears; it also sits at the top of the ops queue for ops and the
     founder. Alerts are about the platform, never about a client or partner, and carry no personal data.
   - `GET /api/health/jobs` answers 200 or 503 with the last completed run, for an external monitor.
   - A System page under Setup (founder, ops, finance) shows recent runs, their steps and durations, the outbox
     backlog and the open alerts.
4. **Audit chain verified nightly.** The jobs verify the whole audit chain once per Dubai day and record the result;
   a break opens a critical alert. `pnpm verify:audit` is unchanged.
5. **Idempotency keys.** Any POST, PUT or DELETE may carry `Idempotency-Key`. The first request with a key runs; a
   repeat with the same key, path and body gets the first answer again (marked as a replay); the same key with a
   different request is refused; a repeat while the first is still running is told to wait. Keys belong to the person
   (or, for public routes, are not accepted), are kept 24 hours, and are erased with the person. The web app sends a
   key with every change and reuses it when it retries after a network failure or a second click on the same form.
   Webhooks keep the provider's event id.
6. **State machines as data with one `transition()`.** Milestones, offers and engagements change status only through
   one `transition()` in the API, which locks the row, checks the transition table in `packages/core/src/states.ts`
   for who may make it, sets the status and the transition's timestamp, and writes the audit event. A test fails if
   any other code updates those statuses. A refused transition says what can happen next.
7. **Route modules and an OpenAPI contract.** `server.ts` keeps the app's hooks; the routes move to modules under
   `src/routes/` by area. Every route declares its body and query schemas in one place; `GET /api/openapi.json`
   serves an OpenAPI 3.1 document built from them, `docs/openapi.json` is the committed copy, and a test fails when
   they differ or when a route that changes something has no body schema.
8. **Real Postgres in CI.** A CI job runs the API suite on PostgreSQL 16 beside the PGlite run, with tests that run
   requests at the same time (two acceptances of one offer, two payout runs, two responses to one allocation, the
   same idempotency key twice): one wins, the other is refused, nothing is created twice.
9. **Load test.** `pnpm load` drives the allocation and payout paths on Postgres with many engagements at once and
   reports throughput, latency (p50, p95, max) and the invariants afterwards (one payout per stage, no partner paid
   above the priced cost, the audit chain intact). The report is evidence; the CI job runs a small version.

## Exclusions

- An external metrics or tracing service (CloudWatch dashboards, Prometheus, OpenTelemetry): the logs are JSON and
  the staging alarms stay as they are.
- Paging, on-call rotations, or SMS alerts.
- A shared rate limiter for several instances (still at the proxy, KNOWN-GAPS).
- Screen changes beyond the System page and the idempotency key in the web app's requests.

## Acceptance evidence

- `apps/api/test/hardening.test.ts`: configuration rules (each refusal, no value in the message); request id in and
  out; user and organisation on log lines and no email, cookie or token anywhere in the log; a server error returns
  its request id; one jobs run at a time and a dead run closed; each alert opens once, is emailed, reminds after four
  hours and clears; alerts carry no personal data; `/api/health/jobs`; the nightly audit check and its alert on a
  tampered row; idempotency replay, mismatch, in-progress, other person's key, public route refusal, erasure; System
  page roles.
- `apps/api/test/transitions.test.ts`: every allowed and refused transition through `transition()`; a source scan
  finds no other status update for the three machines.
- `apps/api/test/contract.test.ts`: the served document equals `docs/openapi.json`; every changing route has a body
  schema; the document is valid OpenAPI 3.1 in shape.
- `apps/api/test/concurrency.test.ts`: the races above, run on PostgreSQL 16 in CI.
- `pnpm test` and `pnpm typecheck` clean; the API suite on PGlite and PostgreSQL 16; the smoke test passes against a
  fresh demo with the System page at 1280 px and 390 px and axe clean; the load test report under
  `docs/evidence/O13/`.

## Dependencies and owner decisions

Depends on O11 (the outbox) and O12 (the web modules). Needed from the owner: the alerting destination
(`ALERT_EMAIL`, and the staging `alarmEmail`). Until it is set, alerts show in the ops queue and the System page and
are written to the log, and nothing is emailed.

## Risks

- Moving every route: done section by section with the suite and the smoke test green after each; no route changes
  its path, roles or answers.
- Idempotency storing answers: kept 24 hours, per person, only for changes; erased with the person.
- An alert storm: one alert per kind and subject, reminders at most every four hours.

## Rollback

Migration 012 only adds tables. Reverting the branch restores the previous server; `job_runs`, `alerts` and
`idempotency_keys` can stay or be dropped.
