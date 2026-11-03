# Right UAE Entity programme: baseline, gap matrix and plan

Released by the owner on 2 Nov 2026 ("Master engineering execution contract": the Tasees + Right UAE Entity
Intelligence Platform). This page is the programme's working record. Each phase ships as its own outcome
(`outcomes/E<n>-*.md`) and its own reviewed pull request; this page is updated in the same pull request.

## 1. Baseline (Phase 0, run on 2 Nov 2026)

**Repository.** Default branch `main` at `a9274f4` (S1 merged, camayank/mkw-uae-growth#16). The work branch for E1 is
`outcome/E1-entity-correctness`. The local branch `asp-selector` (three commits, not on `main`) belongs to an earlier,
separate e-invoicing provider selector; it is not part of this programme and is left untouched.

**Executed here, on `main` before any change:**

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | pass |
| Typecheck | `pnpm typecheck` | pass |
| Tests | `pnpm test` | **3 failures**: 57 core pass; API 261 pass, 3 fail, 1 skipped (PostgreSQL-only) |
| Build | `pnpm build` | pass |

**Historical CI (not executed here).** The last CI run on `main` passed on 25 Oct 2026, so the code was green when it
merged ([run 45](https://github.com/camayank/mkw-uae-growth/actions/runs/40231959467)). The three failures are date
dependent and appeared when the calendar month changed:
- Reporting and partner scorecards dated a step's approval by its audit event. Audit events use the database's real
  clock, as an audit trail must; everything else uses the application clock. In a test (and in any data moved between
  months) the two disagree.
- One test read "this month" on the real clock against data stamped on the test clock.

They are fixed in E1 (migration `013_milestone_dates.sql`: `approved_at` and `first_disputed_at` on the step itself,
backfilled from the audit trail). Reporting no longer reads audit timestamps.

**Outcome statuses reconciled.** `outcomes/QUEUE.yaml` lists S1 as `verified-pending-merge`; it merged as #16 and is
now recorded as `merged`.

## 2. What exists and what this programme adds

Status per contract capability:
- **Built** works end to end with tests.
- **Partial** exists but does not meet the contract's bar.
- **Missing** is not started.
- **Blocked** needs something only the owner or a third party can supply.

### A. Right UAE Entity: public decision engine

| Feature | Status | Where, or what is missing |
| --- | --- | --- |
| Public, no-registration assessment | Built (E3) | `selector.html`: adaptive questions, a public assessment filtered to what is approved for display (D80), printable, ending in a review request with consent |
| Activity discovery and industry questionnaires | Partial | 13 activity groups; no exact licensing activities (E2) |
| Founder and ownership profiling | Partial (E1) | Owner type and foreign tax residence added; nationality, UBO and parent jurisdiction to come (E3) |
| Mainland / free zone / offshore comparison | Built (E1) | Every structure assessed with a status and its reasons |
| DIFC and ADGM pathways | Partial | Assessed as one structure; separate regimes (DFSA, FSRA) only in findings |
| All seven emirates | Partial (E2) | Authorities in all seven. Umm Al Quwain and Fujairah places exist but stay inactive until their figures are recorded |
| Verified jurisdiction directory, map | Partial (E2) | 22 authorities with aliases. Places carry append-only evidence that goes stale; coordinates only with a source. Verification needs owner data; the map is E3 |
| Activity eligibility checks | Partial (E2) | Never assumed from a sector tag. An activity list on record confirms the activity group at its evidence's confidence. Exact activities need each authority's list |
| Licensing and regulator requirements | Partial (E1) | Health, education, food, finance, virtual assets, industrial: as conditions with rule keys |
| Setup and renewal cost estimates | Partial (E2) | Setup and renewal ranges as facts with sources; all unverified until the owner's data |
| Visa and premises requirements | Built (E1) | Standard package versus hard limit; offshore excluded for visas and premises; facilities on record |
| Corporate tax and VAT considerations | Built (E1) | Ordinary regime, QFZP conditions, small business relief window, VAT on taxable supplies, designated zones |
| Cross-border flags | Built (E1) | Founder residence, permanent establishment, corporate shareholder: always a specialist's review |
| Explanation of rejected or uncertain alternatives | Built (E1) | Excluded places and structures with the failing rule |
| Downloadable report; consultation | Partial (E3) | The result page prints; the review request creates the lead and request. Consultation booking is E4 |

### B. Entity intelligence engine

| Module (contract §3B) | Status |
| --- | --- |
| 1 Entity architecture | Partial (E1): one entity; holding plus operating structures (E3) |
| 2 Jurisdiction eligibility | Built (E1): `packages/core/src/eligibility.ts` |
| 3 Activity classification | Partial: activity groups, exact activities in E2 |
| 4 Sector approvals | Partial (E1): conditions per regulated sector |
| 5 Mainland market access | Partial (E1): distributor, branch or permit as a condition; activity-specific permits need data (E2) |
| 6 Ownership and UBO | Partial: UBO obligation; mainland foreign-ownership check is "to confirm" |
| 7 Visa and immigration | Built (E1) for package and limit; dependants and quotas by office size need data (E2) |
| 8 Facility and substance | Partial (E1): facilities on record per place (E2 data) |
| 9 Corporate tax | Partial (E1): statements with conditions, no calculation |
| 10 VAT and designated zones | Partial (E1) |
| 11 Customs and import/export | Missing (E2) |
| 12 Cross-border tax and PE | Partial (E1): flags only, by design |
| 13 Banking readiness | Missing (E3) |
| 14 Cost and renewal comparison | Partial (E2): setup and renewal estimates per place, with evidence |
| 15 Restructuring and expansion | Missing (E3) |
| 16 Compliance obligations | Built (O8) for the calendar; the engine lists the follow-on obligations |
| AI limits | Built (O5): AI drafts into a review queue only; no AI in the engine |

### C. Lead intelligence and sales engine

| Feature | Status |
| --- | --- |
| Anonymous sessions, assessment persistence and recovery | Built (E4): saved on the founder's action, no contact details, recovered by code, anonymised after the retention period |
| UTM and referral attribution | Built (E4): the five UTM fields, referrer and landing page on the session, the lead and the request |
| Distinct assessment, lead and customer identities | Built (E4): `assessments`, `leads`, and the client organisation they become |
| Consent records | Built (E4): service, marketing and partner disclosure as separate append-only records with the text version; withdrawals recorded; in the export and erasure paths |
| Scoring, segmentation, complexity, high-intent detection | Built (E4): complexity and intent scores, five segments, a high-intent flag; heuristics that order attention |
| Expert routing, consultation booking, CRM pipeline, follow-ups | Built (E4) as internal work: routing per segment to an owner, call requests and follow-ups in the ops queue, the leads page. No booking integration (owner decision, rules 7 and 11) |
| Conversion and source-to-revenue analytics | Built (E4): per source and campaign, assessments to accepted client revenue |

### D. Tasees fulfilment

Built and preserved (O1–O13, S1): scoping with ops review, partner selection and sealed quotes, MKW pricing with the
margin floor, offers, acceptance, payments and invoices, allocation, milestones and evidence, QA, client approvals,
compliance calendar, reporting, the outbox, alerts, idempotency, RLS and column grants, the audit chain.

Added in E1:
- A formation quote waits for a settled structure.
- Approving a different structure re-scopes the request.
- An excluded structure cannot be approved or quoted.

Added in E5:
- A saved public result becomes a request for the signed-in client without re-typing, and a held enquiry becomes a
  request for the existing client on ops' action; the review shows then against now.
- A trade licence renewal is asked for from the obligation that is due, quoted and delivered through Tasees, and its
  delivery meets the obligation.

## 3. Conflicts with the existing contracts (recorded, not worked around)

1. **Public assessment versus rule 5 (CLAUDE.md), D30 and D59.**
   - **The conflict.** Today nothing UNCERTAIN reaches a client until a person approves it, case by case. The
     contract asks for a useful public assessment before contact details, and so before any per-case review.
   - **Resolution, authorised by the owner on 2 Nov 2026 (D80).** The public selector shows only statements and
     figures whose rule or data a named person has approved for public display, once per rule or place version
     (not per case). Implemented in E3.
   - **Everything else.** Anything not approved for public display shows only as "to be verified", with no
     figure. Every public result is labelled preliminary, general information, not advice. Per-case review stays
     as it is for anything that becomes a quote or a client's advice.
2. **Rule 6, no unattended side effects.** Consultation booking and follow-up tasks (E4) create internal tasks only.
   Nothing is sent to a lead without a person or an explicit, tested rule with consent.
3. **Rule 1, money privacy.** Recommendations never read partners, rate cards or margin. `assess()` takes no
   commercial input, and a test asserts it.

## 4. Phases

| Phase | Outcome | Business result | Owner inputs |
| --- | --- | --- | --- |
| 0 + 1 | **E1** Entity correctness (`outcomes/E1-entity-correctness.md`) | The engine never recommends a structure the rules exclude, explains every exclusion, and a formation quote waits for a settled structure | None to merge; rule and data verification by a named person to lift the UNCERTAIN labels |
| 2 | **E2** Jurisdiction catalogue and evidence | Authorities, places, activities, packages, fees and facts in versioned rows with source, evidence date, verifier and next verification; stale data downgrades confidence; advice records the data version | Authoritative data (authority activity lists, packages, fees) and a named verifier |
| 3 | **E3** Public Right UAE Entity selector | Adaptive questions, comparison, report, consultation request, mobile-first | Decision on section 3.1; report wording; legal disclaimer text |
| 4 | **E4** Lead intelligence | Sessions, separate consents, attribution, two scores, routing, consultations, CRM pipeline, analytics | Routing owners per segment; marketing consent text; retention for leads |
| 5 | **E5** Assessment to Tasees handoff | An assessment becomes a request for the same customer, re-checked against current rules, and is quoted, bought and delivered through Tasees | None beyond E2–E4 |
| 6 | **E6** Verification and pilot readiness (`outcomes/E6-pilot-readiness.md`) | The 26 contract scenarios end to end as a permanent suite; regression, security, browser, load and audit checks executed and reported; staging checks named as blocked | Staging account (O7) for the blocked checks |

**Rollback.**
- Each phase reverts on its own.
- Migrations only add tables and columns.
- E1's engine change is in pure functions, guarded by the founder-case tests.

## 5. Pilot readiness (E6, 2 Nov 2026)

What the pilot starts with, in one place: `docs/evidence/E6/VERIFICATION.md` (every check: executed, CI-only or
blocked) and `docs/evidence/E6/SCENARIOS.md` (every contract scenario and check mapped to its test). In short:

- **Engine and catalogue.** Every scenario gives the contract's status, exclusion and reasons on the seeded
  catalogue, with nothing verified: no place is ever `ELIGIBLE_VERIFIED`, no estimate is ever shown as a price, and a
  missing record is named rather than assumed. Lifting the UNCERTAIN labels is the owner's data and verifier (E2).
- **Public, leads, handoff.** The public selector shows only what a named person approved for display; leads carry
  separate consents and withdrawals; a saved result or held enquiry becomes a request on a person's action and is
  re-checked; renewals are quoted and delivered through Tasees.
- **Not modelled yet** (gaps 75–77): several activities per assessment, holding-plus-operating structures, a
  renewal comparison for an existing licence. Each is tested for honest behaviour: a person decides.
- **Blocked** (gap 80): staging and every live check, until the owner's AWS account, domain and SES exist (O7).

## 6. E7: commercial launch readiness (released 3 Nov 2026)

The owner's E7 contract ("Commercial launch readiness and product excellence") continues the programme in five
outcomes, each its own reviewed pull request: E7A public product UX, E7B jurisdiction data operations, E7C lead
conversion intelligence, E7D reporting and advisory experiences, E7E commercial pilot readiness. Phase 0 of E7 was
run on `main` at `92ca94b` and is recorded in `outcomes/E7A-public-product-ux.md`, with the E7 acceptance criteria
mapped to what exists (works, partial, missing, later).

**E7A** (`outcomes/E7A-public-product-ux.md`, D85): the selector becomes the product's homepage; the questions are
ordered by industry with a reason each; the result reads as a decision with a side-by-side comparison; general
guidance notes are approved for public display like rules (kind `guide`); an approved place shows its official source
and facilities. The gap matrix above changes in one row: "Downloadable report; consultation" stays partial (the
report is E7D); "Public, no-registration assessment" gains the homepage, the comparison and the guidance.

