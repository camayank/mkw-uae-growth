# O1 Production foundation

Status: released (not started)

## Business result

The platform can run for real clients on hosting in a UAE region, with MKW staff able to create partner
firms and users from the console, without anyone touching the database by hand.

## Scope

- Compiled production build (`tsc` to `dist/`), with the Dockerfile running the compiled output.
- Object storage adapter (S3-compatible API) for evidence files, behind the existing `Storage` interface,
  with an in-memory double in tests. Server-side encryption on; a UAE region configured by environment.
- Continuous integration: install, typecheck, test and the browser smoke test on every pull request.
- Backups and a restore drill script with a written result (`docs/RESTORE-DRILL.md`).
- Console screens and API for: creating a partner organisation and its first admin; inviting, changing
  the role of and deactivating users in any organisation (founder and ops; finance read-only).
- PDPL data requests: export everything held about a person as JSON; erase personal fields while keeping
  invoices and audit rows that tax law requires (replace with a tombstone and an audit event).
- Retention settings (periods held in settings, default values marked UNCERTAIN until the owner confirms).

## Exclusions

Email delivery (O2), payments (O3), new pricing rules (O4). No change to the margin, allocation or
visibility rules.

## Acceptance evidence

- Tests: partner and user creation, role changes, deactivation blocks sign-in, data export contains only
  that person's data, erasure keeps the audit chain valid, storage adapter contract tests.
- Security tests still pass unchanged.
- Smoke test passes; screenshots of the new console screens at 1280 px and 390 px.
- Staging URL running the compiled build (once the owner provides the cloud account), and the restore
  drill log.

## Dependencies and owner decisions

- Cloud account and region (Azure UAE North or AWS me-central-1 suggested), domain name.
- Retention periods for documents and records (lawyer to confirm).

## Risks

- Erasure must not break the audit hash chain: erase by tombstoning personal fields, never by deleting rows.
- Database role creation needs `CREATEROLE` on managed Postgres; document the one-off DBA step.

## Rollback

Each piece ships behind its own route or adapter; reverting the pull request restores the starter. The
local disk storage adapter stays available by configuration.
