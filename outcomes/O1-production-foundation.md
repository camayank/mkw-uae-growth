# O1 Production foundation

Status: merged (pull request camayank/mkw-uae-growth#1 into `main`, 18 Oct 2026; was: branch `outcome/O1-production-foundation`, 16 Oct 2026)

## Business result

The platform can run for real clients on hosting in a UAE region, from a compiled build, with evidence files
in encrypted object storage, daily backups that have been proven restorable, and MKW staff able to create
partner firms and manage users from the console, without anyone touching the database by hand. A person's
data can be exported or erased on request under the UAE PDPL without breaking tax records or the audit chain.

## Scope

1. **Compiled production build.** `pnpm build` compiles `packages/core` and `apps/api` with `tsc` to `dist/`;
   `pnpm start` and the Dockerfile run the compiled JavaScript under Node 22 with no TypeScript loader.
   Development (`pnpm dev`), tests and the seed script keep running the TypeScript sources directly.
2. **Object storage adapter.** `s3Storage()` in `apps/api/src/lib/storage.ts` speaks the S3 API (AWS
   Signature Version 4, written with `node:crypto`, no new dependency) behind the existing `Storage`
   interface. Every upload asks for server-side encryption. Bucket, region and endpoint come from the
   environment, so the same adapter works on AWS me-central-1 (UAE) or any S3-compatible store in a UAE region.
   `memoryStorage()` stays the test double; `localStorage()` stays for development. Chosen by `STORAGE=s3|local`.
3. **Continuous integration.** `.github/workflows/ci.yml` runs install, typecheck, unit and API tests, the
   compiled build, and the browser smoke test against the compiled build on every pull request, and keeps the
   screenshots and smoke log as artifacts.
4. **Backups and restore drill.** `scripts/backup.sh` (pg_dump, custom format, dated file, optional upload to
   the backup bucket) and `scripts/restore-drill.sh` (restore into a scratch database, verify the audit hash
   chain and row counts). `pnpm verify:audit` recomputes every audit hash. The drill is run on Postgres 16 and
   its result written to `docs/RESTORE-DRILL.md`.
5. **Console: partners and users.** API and screens to create a partner organisation with its first admin;
   to invite a user into any organisation, change a user's role (within that organisation's kind) and
   deactivate a user. Founder and ops may write; finance reads only; users of the MKW Advisors organisation
   itself are managed by the founder only. A deactivated user cannot request a code or use an existing
   session. Every change is audited.
6. **PDPL data requests.** `POST /api/admin/users/:id/export` returns everything held about a person as JSON
   (ops and founder). `POST /api/admin/users/:id/erase` (founder only) deactivates the person, replaces name,
   email and message text with tombstones, deletes sessions and sign-in codes, and keeps payments, payouts,
   offers, invoices-to-be and every audit row untouched, so tax records and the hash chain stay valid. Each
   request is recorded in `data_requests` and in the audit trail.
7. **Retention settings.** Retention periods live in `settings` under `retention`, each marked `UNCERTAIN`
   until the founder confirms them after legal advice (`PUT /api/admin/settings/retention`). Nothing is deleted
   automatically in this outcome; the periods are recorded and displayed.

## Exclusions

Email delivery and templates (O2); card payments, invoices and payout runs (O3); new pricing rules or
catalogue changes (O4); automatic deletion at the end of a retention period (needs confirmed periods and a
lawyer's sign-off; later outcome); e-signature; Arabic. No change to the margin, allocation or visibility rules.

## Acceptance evidence

- Tests (`pnpm test`): partner and user creation; role change stays within the organisation kind; ops cannot
  manage MKW Advisors users; finance cannot write; deactivation blocks a new sign-in code and kills an existing
  session; export contains only that person's data and nothing about anyone else; erasure keeps payments and
  audit rows and the recomputed hash chain stays valid; storage contract tests for the memory, local and S3
  adapters (the S3 adapter against a loopback fake S3 server, with the AWS-published SigV4 test vector).
- The existing security tests pass unchanged, plus new ones that read the new tables and fields as every role.
- `pnpm typecheck` clean; `pnpm build` produces `dist/` and the server starts from it.
- `scripts/smoke.mjs` passes against a fresh demo (extended for the admin screens); screenshots at 1280 px and
  390 px of each new screen in `docs/evidence/O1/`.
- `docs/RESTORE-DRILL.md` with the drill result on Postgres 16.
- Staging URL once the owner provides the cloud account (not available in this run; see "Could not verify").

## Dependencies and owner decisions

- Cloud account and region (AWS me-central-1 suggested because S3 and RDS are native there; Azure UAE North
  needs an S3-compatible gateway for blob storage), domain name.
- Retention periods for documents and records (defaults below are marked UNCERTAIN until a lawyer confirms):
  tax and accounting records 5 years after the end of the tax period (FTA requirement, 15 years for real
  estate); client documents 5 years after the engagement completes; messages 5 years; audit trail kept
  indefinitely; sessions 14 days; sign-in codes 24 hours.
- Whether ops (not only the founder) may erase a person's data. Built as founder-only.

## Risks

- Erasure must not break the audit hash chain: the hash covers the event's data, so audit rows are never
  edited; personal fields in the live tables are replaced with tombstones instead.
- Database role creation needs `CREATEROLE` on managed Postgres; documented as a one-off DBA step in DEPLOY.md.
- The S3 adapter is hand-written; the SigV4 test vector and the fake-server tests cover it, and a real
  bucket should be exercised in staging before the first client file.
- Node resolves `@tasees/core` to its compiled output only with `--conditions=production`; `pnpm start` and
  the Dockerfile set it, and CI starts the server exactly that way.

## Rollback

Each piece ships behind its own route, adapter or script; reverting the pull request restores the starter.
Migration `002` only adds columns, a table and a settings row, so the previous code runs against the new
schema. `STORAGE=local` keeps the disk adapter; `pnpm dev` keeps the uncompiled path.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests and typecheck | `pnpm test`: 40 core + 59 API = 99 passing (baseline 68); `pnpm typecheck` clean. The same 59 API tests pass on PostgreSQL 16.15 with `TEST_DATABASE_URL` (run locally on 16 Oct 2026). |
| Partner and user administration | `apps/api/test/admin.test.ts` (10 tests: creation, invitation, role kind, finance read-only, ops kept out of MKW staff, deactivation revokes sessions and codes, reactivation, self-protection, input validation) |
| PDPL export and erasure | `apps/api/test/pdpl.test.ts` (9 tests: export scope, no audit payloads in an export even after a partner's change order, who may export, erasure keeps payments/payouts/audit rows byte-for-byte and the chain re-verifies, tamper detection, time-zone independence, database denies the new tables to clients and partners, retention confirmation audited) |
| Storage adapter | `apps/api/test/storage.test.ts` (12 tests: AWS SigV4 GET and PUT test vectors, contract tests for memory/local/S3, server-side encryption header, signature and region errors, addressing style, environment selection) |
| Security tests unchanged | `apps/api/test/security.test.ts` (8 tests, untouched, passing) |
| Compiled build | `pnpm build`; compiled server started with `NODE_ENV=production` on a fresh database and applied both migrations; runtime stage simulated with `pnpm install --prod` only (no `tsx`): served `/api/health` and the web app. Graceful `SIGTERM` shutdown verified. |
| CI | `.github/workflows/ci.yml` (not yet run: no GitHub repository attached in this session) |
| Backups and restore drill | `scripts/backup.sh`, `scripts/restore-drill.sh`, `docs/RESTORE-DRILL.md` (raw transcript of the PASS on Postgres 16, including the first FAIL that found the privileges gap) |
| Browser smoke test | `scripts/smoke.mjs` against the compiled build on a fresh demo: `docs/evidence/O1/log.txt` (13 hard checks, all OK, no page errors); audit chain of that run verified: 25 events |
| Screenshots, 1280 px | `docs/evidence/O1/16-people.png`, `17-people-after-changes.png`, `18-settings-retention.png`, `19-settings-retention-confirmed.png` |
| Screenshots, 390 px | `docs/evidence/O1/20-mobile-people.png`, `21-mobile-settings.png` (no horizontal overflow) |
| Independent review | A separate reviewing agent read the diff without the author's notes: 1 blocker (audit payloads in the export could carry a client price to a partner) and 12 other findings; all code findings fixed and covered by tests, the rest recorded in `docs/KNOWN-GAPS.md` and `docs/DECISIONS.md`. |

## Could not verify

- A staging URL: no cloud account or domain yet. The image is built and checked only by CI (`image` job), and
  CI itself has not run because the repository has no GitHub remote in this session.
- The S3 adapter against a real bucket: proven against AWS's published test vectors and a loopback fake only.
- The restore drill ran with the drill server being the source server; repeat from the backup bucket onto a
  separate server at the first staging deployment.
