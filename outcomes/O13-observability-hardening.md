# O13 Observability and hardening

Status: merged (pull request camayank/mkw-uae-growth#14 into `main`, 25 Oct 2026; was: branch
`outcome/O13-observability-hardening`)

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
   different request is refused; a repeat while the first is still running is told to wait. Keys belong to the signed-in
   person (without one the header is ignored), are kept 24 hours, and are erased with the person; a person's export is
   never stored as an answer. The web app sends a
   key with every change and reuses it when it retries after a network failure or a second click on the same form.
   Webhooks keep the provider's event id.
6. **State machines as data with one `transition()`.** Milestones, offers and engagements change status only through
   one `transition()` in the API, which locks the row, checks the transition table in `packages/core/src/states.ts`
   for who may make it, sets the status and the transition's timestamp, and writes the audit event. A test fails if
   any other code updates those statuses. A refused transition says what can happen next.
7. **Route modules and an OpenAPI contract.** `server.ts` keeps the app's hooks; the routes move to modules under
   `src/routes/` by area. Every route declares its body and query schemas in one place; `GET /api/openapi.json`
   serves MKW staff an OpenAPI 3.1 document built from them, `docs/openapi.json` is the committed copy, and a test fails when
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

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 57 core + 263 API = 320 (O12: 275), all passing on PGlite (one PostgreSQL-only test skipped there) and on PostgreSQL 16, including a brand-new server; `pnpm typecheck` clean. New: `hardening.test.ts` (22), `transitions.test.ts` (7), `contract.test.ts` (6), `concurrency.test.ts` (11); CI now runs the API suite on PostgreSQL 16 too |
| Configuration | each misconfiguration refused with "NAME: rule" and never the value; production refuses `DEV_LOGIN=1`, http `APP_URL`, a short webhook secret, `EMAIL=ses` without senders and region, `STORAGE=s3` without bucket and region |
| Logs | a load balancer's request id is kept and returned, a malformed one replaced; every line after sign-in carries user, organisation and role ids; no email, query string, token, cookie or header in any line of a request; a server error answers with its request id and no internals |
| Jobs and alerts | each run and step recorded with duration and count; one run at a time, a dead run closed after 30 minutes; jobs late, a failed step, stuck messages and a broken audit chain each open one alert, emailed from "MKW Advisors", reminded after four hours, cleared with an email, opened and closed in the audit trail; an email address in step error text is replaced; the alert tops the ops queue with no buttons; `/api/health/jobs` 503 when late, times only |
| Audit check | the chain is verified once per Dubai day; a changed row opens a critical alert |
| Idempotency | a repeat gets the first answer (marked as a replay) and creates nothing; a different request with the key is refused (422); a repeat while running is told to wait (409); keys are per person, refused on public routes and when malformed; a refusal is replayed; a server error releases the key; erasure and the 24-hour purge remove keys; the smoke test sees a key on every change the web app sends |
| Transitions | every listed move made on a real row with its timestamp and audit event; every unlisted move, for every actor, refused with what can happen next; a source scan finds no other status update for the three machines |
| Contract | `GET /api/openapi.json` equals `docs/openapi.json` (134 paths, 140 operations); every route that changes something declares its body or that it reads none |
| Races (PostgreSQL 16) | two acceptances of one offer, two tiers accepted at once (six rounds), a deposit and a reallocation on different engagements (six rounds), two deposit recordings, two answers to one allocation, two reallocations, two QA decisions, two payout releases, two payout runs, two deposits against the last unit of capacity, the same idempotency key twice: one wins, nothing is created twice. Without their locks: the allocation answer gave `[200, 200]`, two reallocations offered a line twice, two tiers deadlocked (`[200, 500]`), and so did a deposit against a reallocation until the audit lock was taken first |
| Lost connection | a connection ended by the server is logged and replaced and the next request succeeds; without the pool's error listener the process crashed (found by the load test) |
| Load | `docs/evidence/O13/load-test.md`: 200 engagements, 20 at a time, on PostgreSQL 16, about 50 engagements a second, p95 under 330 ms on every step, all eight invariants hold |
| Smoke | `docs/evidence/O13/log.txt`: 174 checks OK on a fresh demo, including the System page and an idempotency key on every change ops sent (8); `79-system.png` (1280 px), `80-mobile-system.png` (390 px); axe-core zero WCAG 2.1 AA violations on 30 screens (`axe.json`) |

## Could not verify

The alert email reaching a real inbox (no `ALERT_EMAIL` or SES yet; tested with the memory transport). The staging log
queries and the CloudWatch alarm with the new log format (no AWS account yet). Load beyond one machine: the test runs
the API in-process against a local PostgreSQL 16, not over a network against RDS.

## Review

A reviewer who had not seen the build read the contract and the diff, ran the suites on PGlite and on a fresh
PostgreSQL 16, and raced the new code paths. Every finding is fixed, with a test that fails without the fix:

| Finding | Fix |
| --- | --- |
| Two allocation runs on one engagement could offer the same line twice: the lines were read before the lock | The lock is the first thing an allocation (automatic or manual) does; a race test of two reallocations |
| The demo stack (`NODE_ENV=demo`) would refuse to start | `demo` is allowed; the demo stack's environment is a test case |
| The new CI job would fail on its fresh PostgreSQL: parallel test databases raced to create the server-wide roles | `test/global-setup.ts` creates them once; a brand-new server now passes first time (it failed without) |
| A person's PDPL export was stored as an idempotency answer, and erasure left other people's answers that quoted them | The export is never stored; erasure deletes any stored answer quoting the person's email or name |
| Error text with personal data reached logs, job records, the System page and the audit trail | One cleaner for error text (a Postgres key's value, addresses); pino's error serializer keeps type, code, message, stack |
| Accepting two tiers at once could deadlock (500) | Acceptance locks all the request's offers in id order first; six-round race test |
| Some moves (withdrawals, expiries, engagement status) wrote no audit event | `transition()` always audits: the caller's event or `<machine>.status_changed` |
| Staging would only print alert emails (`EMAIL=console`) | A start-up warning, and the gap and runbook say so |
| A keyed request from an expired session got 400, and a webhook with the header would be refused | Without a signed-in person the header is ignored: 401 as before, webhooks untouched |

Nits fixed: a long run is only taken as dead when no step has finished for 30 minutes (a heartbeat), so runs cannot
overlap; the contract describes objects as zod strips them, is staff-only, and a test checks each declared schema is
the one its handler parses (the intake preview's was not); the status scan catches aliased updates; the smoke test
checks every change in the ops session; request logs no longer carry the client's address.

After the pull request opened, the Codex review found that a deposit (which audits, then allocates) and a reallocation
(which allocates, then audits) took the audit-chain lock and the allocation lock in opposite orders and could deadlock.
Every path that locks and then audits now takes the audit-chain lock first (D68); a six-round race test failed with a
500 before and passes after.
