# O1 Production foundation

Status: in-progress (branch `outcome/O1-production-foundation`)

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

## Evidence paths

Filled in when the outcome is verified (see the end of this file).
