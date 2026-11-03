# Pilot go/no-go record

The owner's decision sheet for starting the commercial pilot. The platform's rows are filled from the evidence in
this folder on the date shown; the human rows are blank until the named person signs. A row left blank is a no-go
for that row, not a pass. Nothing here is a production deployment or a claim of live readiness: staging does not
exist until the owner's accounts do (`STAGING-CHECKLIST.md`, section 2).

Evidence date: 3 Nov 2026, branch `outcome/E7E-pilot-readiness` (final code of E7A to E7E).

## 1. What the platform proves about itself (filled by the build)

| Criterion | Result | Evidence |
| --- | --- | --- |
| Every suite passes on the final code, on PGlite and on PostgreSQL 16 | pass | `SECURITY-REGRESSION.md` rows 1–4 |
| The screens work end to end, on a phone, with no accessibility violation, and the run's audit chain verifies | pass | rows 5–7 |
| Races on allocation and payouts hold every invariant under load | pass | row 8 |
| No known vulnerability ships; development tools patched | pass | row 9 |
| The six pilot journeys run end to end with every launch-gate invariant | pass | `PILOT-JOURNEYS.md` |
| Money is private by role at three layers (database, visibility map, tests) | pass | `security.test.ts`, journeys C, D, E |
| Nothing is sent, paid, released or filed without a person | pass | journeys A to D; `outbox.test.ts`, `payments.test.ts` |
| Personal data: consent at intake, masking, export, erasure, retention | pass (code); the texts await the lawyer | journey F, `pdpl.test.ts`, `leads.test.ts` |
| Every public statement is labelled and only approved ones show | pass; nothing approved yet | `public-selector.test.ts`, journey A, the coverage matrix |
| Staging deployed in the UAE region with TLS, email, storage, alerts | **blocked** | owner inputs (`STAGING-CHECKLIST.md`, section 2) |

## 2. What people sign (blank until signed)

| Sign-off | Name | Date | Note |
| --- | --- | --- | --- |
| Owner: decisions confirmed (margin, deposit, guarantee, fairness, retention, holidays, texts) | | | |
| Lawyer: client terms, Partner Network Agreement, PDPL notice and consents, UNCERTAIN and "not advice" wording | | | |
| Tax adviser: disbursements, invoice and credit note layout, corporate tax calendar rules; TRN entered | | | |
| Fee verifier: first monthly pass recorded, name and date on the fees used in the pilot | | | |
| Scoping-rule verifier: the rules the pilot's cases touch verified by name and date | | | |
| Public display: the statements, figures and guidance the public may read, approved by a named person | | | |
| Outside security reviewer: report with severities; findings fixed with a failing-then-passing test | | | |
| Arabic reviewer (only if Arabic launches) | | | |
| Three partner firms at `signed` with rate cards | | | |
| Five consenting clients | | | |
| Staging: health check, email delivered, file stored in the region, alert received, restore drill from a real backup | | | |

## 3. Decision

| | |
| --- | --- |
| Go / no-go | |
| Decided by | |
| Date | |
| Conditions (what must be true during the pilot) | |

## 4. What the pilot report measures (leaves the gate)

On-time rate; request-to-acceptance rate; margin achieved against the rules (finance and founder only); partner
share by category against the fairness cap; payouts paid against invoices; credits issued; issues found, fixed and
open with their numbers; one PDPL export and one erasure on a test person; one restore drill; the sign-offs above;
the owner's go/no-go for launch. The dashboard, the accounting export and the funnel page produce the figures; the
books and the bank statement are reconciled against them, not the other way round.
