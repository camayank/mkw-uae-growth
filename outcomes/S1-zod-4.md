# S1 zod 4 migration

Status: verified-pending-merge (branch `outcome/S1-zod-4` from `main` after O7's preparation merged as camayank/mkw-uae-growth#15;
released by the owner 25 Oct 2026: "do the zod 4 migration")

## Business result

The last advisory in what ships is gone: zod 3's memory exhaustion on oversized constrained collections (gap 43,
D70) is fixed by moving to zod 4. Every request is validated exactly as before, and the API contract stays the same.

## Scope

1. `zod` 3.23.8 → 4.6.7 (exact pin) in `apps/api`.
2. Every schema keeps its meaning: changed APIs updated (records need a key schema, the effect and default wrappers,
   error formatting); no route's accepted input or answer changes.
3. The OpenAPI contract built with zod 4's own JSON Schema export instead of the hand-written converter, with
   `docs/openapi.json` regenerated and any difference reviewed and explained.
4. The 1 MB body cap stays (defence in depth), now with its reason updated.

## Exclusions

Changing what any route accepts; zod in `infra` (none); new validation rules.

## Acceptance evidence

`pnpm test` and `pnpm typecheck` on PGlite and PostgreSQL 16; the smoke test against a fresh demo; `pnpm audit --prod`
clean; the regenerated contract's diff explained in this file.

## Risks

- A schema that zod 4 reads differently (stricter UUIDs and emails, defaults applied differently, error messages):
  caught by the API suite, which sends real bodies to every route, and by the smoke test through the web app.

## Rollback

Revert the branch; no migration and no data change.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 57 core + 265 API = 322 (unchanged count), all passing on PGlite (one PostgreSQL-only test skipped there) and on PostgreSQL 16; `pnpm typecheck` clean |
| Behaviour unchanged | No route test changed; the race tests, idempotency, transitions and the money-privacy tests pass as before |
| Contract | `docs/openapi.json`: the same 140 operations; added only the UUID and email patterns (12), safe-integer bounds, a boolean type on a literal, and the key type of the retention record. The converter test checks the same shapes from zod 4's export |
| Smoke | `docs/evidence/S1/smoke-log.txt`: 174 checks OK on a fresh demo |
| Audit | `docs/evidence/S1/audit-prod.txt`: `pnpm audit --prod` finds no known vulnerabilities |

## Could not verify

Real client input at scale: zod 4's email pattern is stricter than zod 3's, so an unusual but valid address could be
refused at intake. None in the demo data, the importers' samples or the tests is.
