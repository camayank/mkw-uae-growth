# E2 Jurisdiction catalogue and evidence

Status: verified-pending-merge (branch `outcome/E2-jurisdiction-catalogue` from `main` at `8d6d3c2`, E1 merged as
camayank/mkw-uae-growth#17; released by the owner on 2 Nov 2026 with the Right UAE Entity programme,
`docs/ENTITY-PROGRAMME.md`)

## Business result

Every figure and permission the entity engine relies on comes from a recorded fact. Each fact has a source, an evidence
date, a confidence, a named verifier (for verified facts) and a date by which it must be checked again.
- **History.** Facts are never overwritten. A new fact supersedes the old one, and the history stays readable.
- **Staleness.** A fact past its re-verification date automatically loses confidence, so stale data can never pass as
  verified.
- **Traceability.** Each assessment records the version of the rules and data it was computed from. Ops cannot approve
  an assessment built on data that has since changed without recomputing it.

When the owner's verifier supplies authoritative data, it goes in through a dry-run importer or the console, with no
code change.

## Scope

1. **Authorities** (migration 015). Each authority has a kind (free zone authority, mainland department, offshore
   registry, financial centre, regulator), an emirate, an optional parent authority and registrar, a website, and
   aliases.
   - Every place belongs to an authority.
   - A parent or registrar is a recorded fact with a source, never assumed.
   - Umm Al Quwain and Fujairah get their free zone authorities and places. The places stay inactive until their data
     is recorded: no figure is invented.
2. **Fact history** (`catalogue_facts`). The table is append-only: the database refuses update and delete, and the
   application role has no such grants. Facts cover:
   - **places:** cost range, renewal cost range, standard visas, maximum visas, timeline, facilities, the activity groups
     the authority's own list confirms, legal forms, and coordinates (only with a source);
   - **authorities:** parent, registrar, website;
   - **rules:** every verification, as rule history.

   Rules: a verified fact needs a named verifier, an http(s) source and a re-verification date. Recording a fact also
   updates the current-value cache in the same transaction, and writes one audit event.
3. **Effective confidence** (`packages/core/src/catalogue.ts`, pure).
   - A fact past its re-verification date drops one level: verified becomes rule of thumb, and rule of thumb becomes
     UNCERTAIN. It is labelled stale.
   - A place's confidence is the weakest of the facts the engine uses for it.
   - Rules are downgraded the same way.
4. **Engine use of the evidence.**
   - **Activity listing.** A place whose authority's activity list is on record confirms the activity: a pass, at that
     fact's confidence. Otherwise it stays "to confirm".
   - **Named places.** A place the founder names matches by alias as well as by name.
   - **Renewal estimates** are carried to the candidates for comparison.
5. **Advice records its data version** (`dataVersion`): the as-of date, a digest of the effective rules and places, and
   the latest fact recorded.
   - The ops review flags advice whose data has changed since.
   - Approval refuses it until ops recomputes.
   - The client sees the date the advice's data stands at.
6. **Console.**
   - The Scoping page lists authorities and places with evidence status (verified, stale, due).
   - Each place and rule shows its fact history.
   - The founder records facts with source, evidence date, confidence, verifier and re-verification date.
   - The existing verify-zone and verify-rule actions now write facts.
7. **Importer.** `catalogue-facts` reads CSV or XLSX: place or authority, field, value, source, evidence date,
   confidence, verifier, re-verification date.
   - The dry run changes nothing and reports row by row. `--apply` is idempotent.
   - Unknown places or fields are refused, and it sends no notification.

## Exclusions

- Authoritative data itself: no fee, package, coordinate, activity list or relationship is invented here. The seed stays
  UNCERTAIN, and new places stay inactive until their data is recorded.
- Exact licensing activities: ISIC-level codes per authority. Activity groups are confirmed per place; exact
  activities need each authority's list in a machine-readable form.
- A map view. Coordinates are stored with their source; drawing them is part of E3's public selector.
- Customs and import/export rules, and banking readiness (E3).

## Acceptance evidence

- Tests:
  - the database refuses updating or deleting a fact;
  - a verified fact without a verifier, source or re-verification date is refused;
  - a stale fact downgrades confidence, and so do a place's facts and a rule;
  - a listed activity makes the place finding a pass at the fact's confidence;
  - aliases match;
  - advice carries `dataVersion`, approval of advice built on changed data is refused until recompute, and recompute
    clears it;
  - importer dry run and apply are idempotent, with no outbox rows;
  - roles: only the founder records facts; ops and finance read; clients and partners cannot read the tables.
- `pnpm typecheck`, `pnpm test` (PGlite) and the PostgreSQL 16 suite pass. The smoke test passes on a fresh demo, with
  the Scoping page, history and the advice's data date at 1280 and 390 px, and axe clean.

## Dependencies and risks

- **Depends on E1** (merged).
- **Risk: staleness defaults.** Owner input: the re-verification default is 180 days when none is given (D77).
- **Risk: blocked approvals.** Blocking approval on changed data could hold up ops. It costs one click (recompute), and
  the reason is shown.

## Owner decisions

- A named verifier, and the authoritative data per authority: fees, packages, activity lists and relationships.
- Whether 180 days is the right default re-verification period.

## Rollback

- Revert the pull request.
- Migration 015 only adds tables and columns. The current-value cache on `zones` stays as it is, so the E1 engine reads
  it unchanged.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 95 core + 288 API (one PostgreSQL-only test skipped on PGlite) = 383 passing. The API suite passes 289 of 289 on PostgreSQL 16. `pnpm typecheck` is clean |
| Append-only | `jurisdiction.test.ts`: update and delete are refused through the app role, and also as the table owner, where the trigger refuses. Clients and partners cannot read the tables; ops can read but not record (403) |
| Verified evidence | A verifier, an http(s) source and a re-verification date (default 180 days) are required. History keeps superseded facts and marks the current one |
| Staleness | A verified fact past its date counts as rule of thumb and is labelled stale. A verified rule past its date reaches new advice as rule of thumb |
| Engine | An activity list on record passes the activity check at the weaker of rule and evidence (core and API tests). "sharjah media city" finds SHAMS by its authority's name |
| Data version | Advice carries `dataVersion`. A new fact makes the review say the data changed, approval is refused (409) until recompute, and the client sees the date |
| Nothing invented | Authority relationships are facts, and loops are refused. Fujairah Creative City cannot be verified from placeholders or activated without figures; once its figures are recorded, it is offered |
| Importer | Dry run writes nothing; applying twice writes once. Verified rows are skipped without `--as`; unknown places and fields are skipped with the reason; no outbox rows. Empty template: `docs/templates/catalogue-facts.csv` |
| Smoke | `docs/evidence/E2/smoke-log.txt`: 186 checks OK on a fresh demo (E1: 181). It records a verified activity list from the form, sees it on the place, opens its history, and checks the client's advice shows its data date |
| Screens | `82-scoping-catalogue.png` (1280 px, full page), `40-mobile-scoping.png` (390 px, no horizontal overflow), `36-client-advice.png` (authority and data date). axe finds zero WCAG 2.1 AA violations on 34 screens (`axe.json`) |

## Independent review

A separate reviewer read the whole diff before the pull request, with throwaway probes and no repository changes. It
found 2 must-fix problems (both reproduced), 8 should-fix and 10 nits. All must-fix and should-fix items are fixed with
tests (D77 amended):
- **Must-fix.** An activity list's own confidence was ignored (an UNCERTAIN list passed as verified on a verified
  place); a placeholder place could be verified and offered with invented figures once any cost fact existed.
- **Should-fix.** Future evidence dates and unlimited re-check dates; the old Places table showing raw confidence;
  renewal estimates without a label; "JAFZA" naming the offshore registry; a recompute/approve race; cache divergence
  under concurrent writes; untested contract claims (rule history, the database's verified-fact rule, finance
  reading); days judged in UTC rather than Gulf time.
- **Nits** fixed: the digest covers rule parameters and the engine version; money parsing is capped at AED 1 billion;
  the visa cap agrees everywhere; the client no longer receives the digest; the History control and the note field
  are accessible; exact place names win over aliases. Recorded as gaps: 59 to 62.

## Could not verify

- **Any authoritative figure, list or relationship.** None was supplied, and none is invented.
- **Whether 180 days is the right re-verification period** for each kind of fact. This is an owner decision.

