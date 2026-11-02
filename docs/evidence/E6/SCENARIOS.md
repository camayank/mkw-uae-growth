# E6 scenario traceability

The owner's engineering contract (section 11) names 26 scenarios and, for each, eight checks: the eligibility status,
exclusion or escalation, the rationale shown, confidence propagation, no invented price, no unauthorised access, no
irreversible action without a person, and the same answer on the screens as through the API. This table says which
test proves each, on the seeded catalogue where every rule and place is UNCERTAIN until a named person verifies it.

Legend: **S n** = `apps/api/test/scenarios.test.ts`, test *n* (end to end over HTTP, PGlite and PostgreSQL 16);
**core n** = `packages/core/test/eligibility.test.ts`, scenario *n* (the engine on fixtures); other files are under
`apps/api/test/` unless stated. Smoke = `scripts/smoke.mjs` on a fresh demo (`smoke-log.txt`, 213 checks).
Checks: E eligibility · X exclusion/escalation · R rationale · C confidence (only where a verified or rule-of-thumb
input exists to propagate; on the seeded catalogue everything else is UNCERTAIN and cannot fail) · P no invented
price · A access · I no irreversible action · U UI/API consistency: the smoke run drives the screen and the S test
checks that the client's own API view equals what the review approved (`[client-view]`); U is claimed only where a
smoke check is named.

| # | Scenario | Tests | Checks | Outcome on the seeded catalogue |
| --- | --- | --- | --- | --- |
| 1 | Indian SaaS founder, US clients, two visas | S 1; core 1; `scoping.test.ts` (advice pending until approved); `public-selector.test.ts` (nothing approved: no text, no figure); smoke `83-public-selector-unapproved`, `85-mobile-public-selector` | E R I U A | Free zone; offshore ineligible; founder residence, permanent establishment and QFZP points raised; visa package flagged; client sees nothing until ops approves, then exactly the approved advice; another client and a partner see none of it; public result confirms nothing |
| 2 | UAE mainland retailer, physical store | S 2; core 2; `entity.test.ts` (quotes wait for a settled structure) | E X R P I | Mainland; offshore excluded with three reasons; free zone needs the onshore arrangement; a quote is refused until ops settles mainland, then prices `SET-ML-LIC` only; the client sees prices, never cost or margin |
| 3 | Holding company with visas | S 3; core 3; `entity.test.ts` (offshore with visas refused as approval) | E X R | Never offshore; RAK ICC and JAFZA Offshore excluded with `structure.offshore_no_visas`; ops cannot approve offshore |
| 4 | Holding company, no visas | S 4; core 4 | E P | Offshore, RAK ICC first; the estimate carries the place's UNCERTAIN confidence; the public sees no figure |
| 5 | Foreign corporation subsidiary | S 5; core 5 | R X | Corporate-shareholder point raised; the request waits in the scoping queue for a person, as every new-company request does |
| 6 | Manufacturing, industrial land | S 6; core 6; `jurisdiction.test.ts` (facts, evidence, confidence) | E X C | Without facilities on record a place says the data is missing, and is neither passed nor excluded on a guess; after the founder records facts (rule of thumb), RAKEZ qualifies, IFZA is excluded with a finding capped at the unverified rule's confidence, and settling mainland re-ranks on the record |
| 7 | Food importer, mainland distribution | S 7; core 7 | E R | Mainland with the food-safety approval as a condition |
| 8 | Cross-border e-commerce with storage | S 8 (records its own facts); core 8 | E X R | Designated-zone VAT point raised; places without warehousing on record say so (engine fix in E6, D83); a place recorded as office-only is excluded, one with warehousing qualifies |
| 9 | Regulated financial services | S 9; core 9; `entity.test.ts` (DIFC/ADGM has its own code) | E X I | Generic free zone ineligible; DIFC/ADGM with the regulator pathway as a condition; the quote prices `SET-DIFC` only after approval |
| 10 | Virtual assets | S 10; core 10 and "virtual assets name the right regulator" | E R | Offshore excluded; regulator approval a condition in every viable structure; VARA named for Dubai |
| 11 | Healthcare, licensed premises | S 11; core 11 | E R | Mainland with the health regulator's approval as a condition |
| 12 | University or training institute | S 12; core 12 | E R | Education approval a condition in every operating structure |
| 13 | Free-zone company seeking mainland permissions | S 13; core 13; smoke `90-review-from-saved-result` (the review and the client's advice on screen) | E R U | Free zone kept; the onshore arrangement is a condition, not a promise; the client's advice shows the same finding at the same confidence; the quote prices `SET-FZ-LIC` |
| 14 | Existing free-zone company comparing renewals | S 14; `jurisdiction.test.ts` (renewal estimate carries its own confidence) | C P | Renewal ranges per place with their own confidence; a place with no renewal on record shows none; the public shows no renewal figure. A side-by-side renewal comparison for the client's own licence is not a product: gap 77 |
| 15 | Visas exceed the package limit | S 15; core 15 | E X C | A place whose recorded limit is below the need is excluded; beyond the standard package is a flagged extra; the finding is never more confident than its unverified rule |
| 16 | Insufficient budget | S 16; core 16; `packages/core/test/public.test.ts` (a conclusion from place rules is public only when approved) | E X P I | No place fits, no recommendation invented, a specialist is offered; the public sees no recommendation and no figure (the "no option fits" conclusion waits for the budget rule's approval, D80); no formation quote is published on the engine's say-so, even when the client named the structure (gate added in E6); only a person's audited approval of a structure at the review opens the way to a real quote |
| 17 | Multiple regulated activities | S 17; `scoping.test.ts` (AI drafts change nothing until approved: before and after) | X I | One activity per assessment; the rest reaches a person through the description and the AI draft queue (pending, the scope still the engine's default); no quote is published until a person settles the structure: gap 75 |
| 18 | Holding plus operating company | S 18; core "holding vehicle with visas in DIFC or ADGM" | E X | One entity per assessment: offshore is excluded, the advice is uncertain, and no quote is published until a person settles the structure: gap 76 |
| 19 | Missing jurisdiction source data | S 19; core 19; `jurisdiction.test.ts` (placeholders never offered, cannot be verified from placeholders) | X P | Places without figures (UAQ, Fujairah) are never offered, cannot be approved for public display, and never appear in a public result |
| 20 | Expired regulatory or price source | S 20; `jurisdiction.test.ts` (stale evidence loses a level); `public-selector.test.ts` (stale rule and place lose their approval); `catalogue.test.ts` (a fee verified over 90 days ago goes back to review) | C X | Past the re-verification date a verified rule and place drop to rule-of-thumb in new advice, the public approval lapses, re-approval is refused until checked again |
| 21 | Contradictory answers | S 21; core 21 and "contradictory premises answers keep the premises requirement" | E X R | Contradictions named; the advice needs verification; offshore ineligible; publishing is refused because the request and the advice disagree; ops cannot approve offshore |
| 22 | Withdrawing marketing consent | S 22; `leads.test.ts` (pipeline and withdrawal; export and erasure; retention) | A I | Only MKW's pipeline roles withdraw (ops tested; a partner and another client are refused); the withdrawal is appended, never edited; service consent stands; nothing is sent; the person's export shows it |
| 23 | Cross-client and cross-partner access | S 23; `security.test.ts`; `pdpl.test.ts`; `journey.test.ts` ("partners and other clients never see a client's journey", "another client sees none of this client's actions"); `flow.test.ts` (margin hidden from ops, partner sees cost not price) | A | Another client and every partner get 403 or 404 through every door, and no row at the database; margin columns are refused by the database |
| 24 | Pricing changes after approved scoping | S 24; `entity.test.ts` (an offer built before the structure changed cannot be published; after acceptance only a change order); `catalogue.test.ts` (scheduled rule applies from its date, earlier offers keep their figures; an UNCERTAIN fee stops the line) | P I A | A published offer is a snapshot; re-pricing withdraws it and the new offer reaches the client only when a person publishes; the approved advice stands; ops never sees margin, finance does |
| 25 | Lead to engagement without duplicated customers | S 25; `handoff.test.ts` (held enquiry converted, lead linked, nothing sent); `scoping.test.ts` (held lead); `concurrency.test.ts` (two acceptances make one engagement) | I A | An existing client's public enquiry creates no organisation or user; ops converts it to a request for the same organisation; the engagement belongs to it; marking the lead converted before acceptance is refused and allowed after; every message sent goes to the existing client or MKW and none is about the lead |
| 26 | Existing client, additional assessment | S 26; `handoff.test.ts` (from a saved result, once, recomputed today); smoke `90-review-from-saved-result`, `92-mobile-saved-result` | I U A | A saved code becomes a second request for the same client two days later: the advice carries that day's data version, not the saved one; listed on the client's home, invisible to another client who cannot reuse the code |

## Browser evidence (smoke run on this build)

- Public selector (E3): the adaptive questions, the result with "to be verified" labels, print, the review request
  with consent, Arabic (9 checks name the selector; screens 83, 84, 85).
- Leads (E4) and handoff (E5): held enquiry converted, review from a saved result, renewal requested
  (`docs/evidence/E5/89-92`; the same screens on this build in the smoke output).
- Mobile: 39 checks at 390 px. Accessibility: axe on 40 screens, 0 violations (`axe.json`).
- 91 screenshots at 1280 and 390 px in the run's output folder (four kept here); the audit chain of the run
  verified (`verify-audit.txt`).

## What the suite does not prove

- Any statement about a real jurisdiction: the catalogue is unverified, and the tests assert that the platform says
  so. Verification by a named person is the owner's input (E2).
- Staging behaviour (TLS, SES, S3 in a UAE region, the payment provider): blocked on the owner's accounts (O7).
