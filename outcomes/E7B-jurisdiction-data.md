# E7B Jurisdiction data operations: coverage matrix, evidence pipeline, verification backlog

Status: in-progress (branch `outcome/E7B-jurisdiction-data`, built on E7A; released by the owner on 3 Nov 2026 with the
E7 contract, phase 2 "Regulatory data and jurisdiction intelligence")

## Business result

The founder and the named verifier can see, in one place, what the catalogue holds for every licensing authority and
place in the seven emirates, what is verified, what is stale, what is missing and what is waiting for public-display
approval; they get a backlog of evidence to obtain, ordered by the first commercial wave, in the exact shape the
importer reads back. Every fact can carry the official reference, the effective date and whether the source is
official or an intermediary, and an intermediary's figure can never be recorded as verified. No fee, permission,
package or relationship is invented: a place without evidence stays "not on record".

## Scope

1. **Classification without double counting** (migration 020). Each place carries a `place_kind` (free zone operating
   location, sub-zone or specialised district, offshore registry, mainland authority, regulated financial centre,
   non-free-zone industrial development) and a `status` (active, inactive, historical); each authority keeps its
   kind, with `industrial_development` added. A sub-zone is a place under its parent authority (a recorded fact), never
   a second authority; a historical place is kept for the record and never counted as a candidate or offered.
2. **Evidence fields** (`catalogue_facts`): `effective_date`, `reference` (the exact page, document or section) and
   `source_kind` (official or intermediary). A fact from an intermediary cannot be verified (database constraint and
   service check); the console and the importer carry the three fields. New place fields: `activity_codes` (the
   authority's exact licence activities, code and name), `government_charges` (an AED range of the authority's own
   charges), `conditions` and `exclusions` (lists).
3. **Coverage matrix** (`packages/core/src/coverage.ts`, pure; `GET /api/admin/coverage`; console page Coverage):
   totals by emirate and kind; active, inactive and historical; verification coverage per engine field; exact
   activity coverage; cost, renewal, visa and facility coverage; evidence expiring within 30 and 90 days or stale;
   outstanding public-display approvals (rules, places, guidance notes not approved or lapsed).
4. **Evidence backlog**: one task per place and field that is missing, unverified, stale or due, first-wave places
   first (`zones.priority`), with the reason; downloadable as CSV in the importer's own column layout so the verifier
   fills the Value, Source, Evidence date and Confidence columns and the file comes back through
   `import catalogue --as`. The founder sets a place's kind, status and priority from the console (audited).
5. **First commercial wave** (2C): fifteen places flagged priority 1 across general services, technology, trading and
   e-commerce, industrial, holding and investment, regulated finance and mainland. Two are added as placeholders by
   name only (KEZAD, JAFZA free zone), inactive until their figures are recorded. This flags what to verify first; it
   verifies nothing.
6. **Engine cases** (2D, `packages/core/test/engine-cases.test.ts`): one test per listed case, asserting the engine's
   behaviour where it is modelled and its honest non-claim where it is not (legal forms are on record but never decide
   eligibility; banking readiness is never promised; several activities and holding-plus-operating escalate).

## Exclusions

- No authoritative data is entered: every figure stays as the owner's verifier records it. The container has no
  internet access, so no official page was read here; the backlog says what to obtain and from which authority.
- No change to the public selector beyond what E7A already shows (the comparison reads the same figures).
- No ISIC-level activity matching in the engine: exact codes are recorded and shown; the engine still confirms the
  activity group only (D86), and the exact activity is confirmed at scoping.

## Acceptance evidence

- Core: the matrix counts each authority and place once; a sub-zone counts under its parent and never as an
  authority; historical places are excluded from candidates, tasks and active counts; tasks are deterministic and
  ordered by priority; the CSV backlog round-trips through the importer's header.
- API: an intermediary fact cannot be verified (400, and the database refuses it); the new fields are parsed, cached
  on the place and shown in the history; ops and finance read coverage, clients and partners get 403; only the
  founder sets status and priority, audited; the backlog CSV imports as a dry run with every row skipped (no value)
  and writes nothing.
- Smoke: the Coverage page at 1280 and 390 px, axe clean; a fact recorded with reference and effective date appears in
  the history; the backlog downloads.
- Screenshots under `docs/evidence/E7B/`.

## Dependencies and risks

- Depends on E2 (merged) and E7A (open as a pull request; this branch is built on it and will be rebased or merged
  once E7A lands).
- Risk: classification of the seeded places is by public knowledge of what each is (a free zone, an offshore
  registry, a financial centre, a mainland department); nothing commercial or statutory rests on it.

## Owner decisions

- Name the verifier and hand them the backlog; confirm the first-wave list.
- Whether an intermediary-sourced figure may be shown to clients as a rule of thumb at all (today: yes, labelled; never
  as verified).

## Rollback

- Revert the pull request. Migration 020 adds columns and widens checks only.
