# Security brief for the launch-gate reviewer

O7 asks for a security review by someone outside the build before the pilot. This brief lists what the platform holds,
where its defences are, what has already been tested and how, and what we ask you to try to break. It is a map, not
evidence: the tests and the code are. Read `CLAUDE.md` for the rules the platform is held to.

## What it holds and who uses it

- **Personal data (UAE PDPL):** names, emails and phone numbers of clients, partner staff and MKW staff; client
  documents (passports, Emirates IDs, licences, bank letters); messages between parties.
- **Money:** client prices, partner costs, MKW's margin, payments, payouts, partner bank details (IBAN), tax invoices.
- **Roles:** client owner and member; partner admin and staff; MKW ops, finance and founder. Clients must never see
  partner cost or margin; partners never the client price, margin or other partners' quotes; ops never margin.

## Architecture and trust boundaries

Browser (plain HTML and ES modules, strict content security policy) → HTTPS load balancer → one Fastify process
(`apps/api`) → PostgreSQL (RDS in staging) and an S3 bucket for files, both in me-central-1. Email leaves through SES;
card payments through a provider adapter (not chosen yet; only a test double exists). Scheduled jobs run as a separate
task on the same image. Secrets come from AWS Secrets Manager at start (`infra/lib/staging-stack.ts`).

## Defences, and where to look

| Area | What is in place | Where |
| --- | --- | --- |
| Sign-in | Email one-time codes (10 minutes, 5 attempts, 5 per hour per account), stored as hashes; sessions are random tokens stored as SHA-256, 14 days, `HttpOnly; SameSite=Lax; Secure`; per-address throttles on sign-in and the public intake | `lib/auth.ts`, `server.ts` |
| Authorisation, three layers | Route guards by role; PostgreSQL row-level security and column grants (each request runs under `app_client`, `app_partner` or `app_platform` with the organisation and user set in the session); a field visibility map | `lib/auth.ts`, `migrations/001_init.sql` onwards, `packages/core/src/visibility.ts`, `test/security.test.ts` |
| Money privacy | Tests read every forbidden field as every role, at the database and over HTTP, including exports, notifications and the API contract | `test/security.test.ts`, `pdpl.test.ts`, `journey.test.ts`, smoke test |
| Audit | Append-only, hash-chained audit events for every state change; verified nightly with an alert on a break; `pnpm verify:audit` | `migrations/002`, `services/system.ts`, D65 |
| Integrity under concurrency | One `transition()` for statuses; rows locked before they are checked; one lock order (audit chain first); idempotency keys on every change | D66–D68, `test/concurrency.test.ts` (runs on PostgreSQL 16 in CI) |
| Input | Every route's body parsed with a zod schema (the same schema the OpenAPI contract is built from); bodies capped at 1 MB, 25 MB only for routes carrying a file; uploads checked by extension and size (15 MB); storage keys are generated and cannot leave their folder; files are always downloaded as attachments (`application/octet-stream`), never rendered. No content inspection or malware scan yet (gap 45) | `src/routes/`, `lib/openapi.ts`, `lib/storage.ts`, D69, D70, D71 |
| Files | Private bucket, block public access, SSE, TLS enforced; files served only through the API after a visibility check under the person's own database role | `lib/storage.ts`, `infra/lib/staging-stack.ts` |
| Webhooks | HMAC-SHA256 over timestamp and raw body, five-minute window, constant-time compare; unset secret rejects all | `lib/payments.ts`, `test/payments.test.ts` |
| Browser | CSP `default-src 'self'` (no inline script, no eval), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy: same-origin` | `server.ts`, `test/security.test.ts` |
| Proxy | `X-Forwarded-For` believed only from the load balancer's address range (`TRUST_PROXY`) | `server.ts`, `test/scoping.test.ts` |
| Logs and alerts | JSON logs with request and user ids; no headers, bodies, query strings, client addresses or quoted values; alerts carry no personal data | D64, D65, `test/hardening.test.ts` |
| Configuration | Refused at start when unsafe (development sign-in in production, http `APP_URL`, short webhook secret, incomplete SES or S3 settings) | `lib/config.ts`, D63 |
| PDPL | Consent at intake with version and time; per-person export (never stored as a retry answer) and erasure that keeps what tax law requires and the audit chain | `services/admin.ts`, `services/intake.ts`, `test/pdpl.test.ts` |
| AI | Drafts only, into a review queue, labelled UNCERTAIN; document checks read metadata with names and ID numbers removed from file names | `services/drafts.ts`, `lib/ai.ts`, D54 |

## Dependency audit (25 Oct 2026, `pnpm audit`)

| Package | Ships in the image | Finding | Disposition |
| --- | --- | --- | --- |
| fastify 5.2.0 | yes | 13 advisories (validation and authentication bypasses, DoS) | Upgraded to 5.12.7: none left |
| csv-parse 5.6.0 | yes (owner-run import scripts) | prototype replacement via column names | Upgraded to 7.0.3 |
| fast-uri (through Fastify's validator) | yes | URI scheme and host confusion | Patched versions pinned with a pnpm override |
| zod 3.23.8 | yes | memory exhaustion on oversized constrained collections | Migrated to zod 4.6.7 (S1, D71). The 1 MB body cap (25 MB only for file routes) stays as defence in depth |
| vitest, vite, tinypool, esbuild (through tsx), playwright | no (development and CI only) | issues when a dev server or the Vitest UI listens, or when browsers are downloaded | Not exposed: tests run with `vitest run`, no dev server is reachable, CI is ephemeral. Upgrade with the next tooling change. Gap 44 |

`pnpm audit --prod` reports no known vulnerabilities (S1, 25 Oct 2026).

## What we ask you to try

1. Read another party's money: as a client, partner or ops user, reach margin, partner cost, client price or another
   partner's quote through any route, export, notification, file or the contract. Start from `security.test.ts`.
2. Cross-organisation access: open, change or download another client's or partner's rows or files by id.
3. Sign-in: brute-force a code, reuse a session after sign-out or deactivation, fix a session, abuse the public intake.
4. Escalate a role (invites, role changes, the founder's last-founder guard).
5. Bypass a state rule: approve a step without evidence, pay a partner above the priced cost, double a payout, change
   the audit trail without the nightly check noticing.
6. Webhook forgery and replay; idempotency keys used across people or routes.
7. Upload abuse: content type, size, file names, path traversal in storage keys.
8. The staging stack: IAM scope of the task role and storage user, security groups, the database's network exposure,
   secrets handling, backups and the restore drill (`docs/RESTORE-DRILL.md`).

Report findings with severity; we fix them with a test that fails before the fix, as for every review so far.
