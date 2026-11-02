# E3 Public Right UAE Entity selector

Status: verified-pending-merge (branch `outcome/E3-public-selector`, built on E2 and rebased onto `main` once
camayank/mkw-uae-growth#18 merges; released by the owner on 2 Nov 2026 with the Right UAE Entity programme,
`docs/ENTITY-PROGRAMME.md`)

## Owner authorisation (rule 5)

On 2 Nov 2026 the owner chose, of the three options put to them, **approved rules only**: the public selector shows
only statements and figures whose rule or place data a named person has approved for public display, once per
version (not per case). Everything else shows as "to be verified", with no figure. Every public result is labelled
preliminary general information, not advice. Per-case review stays as it is for anything that becomes a quote or a
client's advice. Rule 5 in `CLAUDE.md` and `BUILD_PROMPT.md` records this in the same commit (D80).

## Business result

A founder can answer a short set of questions on a public page, with no sign-up, and see which UAE structures and
places fit, which do not and why, before anyone at MKW has looked at the case. Only approved statements and figures
appear. Each result ends in a request for MKW's review, which becomes a lead with consent.

## Scope

1. **Public display approvals** (migration 016, `public_approvals`). The founder approves a rule (by version) or a
   place (by the digest of its current figures and evidence) for public display, with a note, and can revoke.
   - An approval covers one version: a new rule version, a new fact, or evidence going stale changes the digest and
     the approval lapses on its own.
   - Only the founder approves or revokes; ops reads. Each decision is audited.
2. **The public view** (`packages/core/src/public.ts`, pure). From an advice and the sets of approved rule keys and
   places, it keeps:
   - approved statements (reasons, licences, obligations, cross-border points) with their text;
   - approved places with their figures;
   - everything else as a placeholder: the rule key or place name with `toBeVerified: true` and no text or figure.
   - The recommendation is shown only when every reason behind it is approved; otherwise "a person will confirm".
   - A structure's "does not fit" is shown only when the failing rule is approved; otherwise "to be verified".
   - Contradictions that restate an offshore rule are gated on that rule.
   - Missing facts are the founder's own questions and are always shown.
3. **Public assessment** `POST /api/public/assess`: the intake answers in, a public view out. Rate-limited per IP.
   Writes nothing (no request, no lead, no audit row). Returns the disclaimer text and the date the rules and data
   stand at.
4. **The selector page** (`selector.html`, phone-first, same CSP as the app). Adaptive questions: activity, customers,
   visas, premises, budget, owners, emirate and a named place, each shown when relevant. Then the result:
   structures compared, places that fit and places that do not, what follows after setup, what would sharpen the
   answer, and a printable report. "Ask MKW Advisors to review this" posts the same answers to the existing public
   intake with the PDPL consent text, which creates the lead and the request as today.
5. **Console.** The Scoping page shows each rule's and place's public-display state with approve and revoke
   (founder), and the count of what the public can see.
6. **Arabic.** `?lang=ar` as on the intake page, once the reviewer's sign-off is recorded.

## Exclusions

- A map (coordinates are stored by E2; drawing them needs an owner decision on a map provider, rule 7 and 11).
- Sessions, separate consents, attribution and scoring (E4).
- A downloadable PDF built on the server; the page prints.
- Holding plus operating structures, and several activities at once (programme gap 48).

## Acceptance evidence

- Core: over a 1,296-combination matrix, with no approvals, no public result contains any rule text, figure, rule key,
  outcome or conclusion; with every rule and place approved, the public result carries the same statements as the
  advice; composite statements and conclusions need every rule they rest on.
- API: approving and revoking are founder-only and audited; an approval lapses when the rule is verified again or a
  fact is recorded; `assess` writes nothing and is rate-limited; the public result never carries partner, cost, margin
  or payout fields; the review request creates a lead with consent and the answers.
- Smoke: the selector at 1280 and 390 px, with and without an approval, through to the review request; axe clean.

## Dependencies and risks

- Depends on E2 (data versions and rule versions).
- Risk: with nothing approved, the public page is honest but thin. That is by design until the owner's verifier
  approves rules.

## Owner decisions

- Which rules and places to approve for public display, after verification.
- The disclaimer wording (a default is used, labelled as such in D80).

## Rollback

- Revert the pull request. Migration 016 only adds a table. The public page and route go with it; nothing else
  depends on them.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 100 core + 296 API (one PostgreSQL-only test skipped on PGlite) = 396 passing. The API suite passes 297 of 297 on PostgreSQL 16. `pnpm typecheck` is clean |
| Nothing unapproved leaks | `packages/core/test/public.test.ts`: over 1,296 founder combinations with no approvals, no rule text, figure, rule key, outcome, authority, preference or conclusion appears in the public view (no "fits", no "does not fit", no "no option fits"), every place the engine knows is listed as "to be verified", and the recommendation is never confirmed; with everything approved, the public view carries the advice's statements, figures and statuses; approving one rule and one place shows exactly those; a composite statement needs every rule it rests on; a place rule shows nothing for an unapproved place; an UNCERTAIN renewal estimate stays out |
| Approvals | `apps/api/test/public-selector.test.ts`: founder-only and audited; an UNCERTAIN or stale rule or place cannot be approved; a new rule version, a stale verification or a new fact lapses the approval ("lapsed: new version"); approving again supersedes (one live approval per subject, enforced by a unique index); withdrawing hides at once; the founder sees the engine's wording for each rule before approving (`texts`), and that wording is part of the version |
| Writes nothing | The public assessment leaves requests, leads, audit events and the outbox unchanged; it is rate-limited (429) and refuses bad input (400); every key and string in the result is checked for partner, cost, margin, payout and digest fields |
| Review request | The selector's review request goes through the existing public intake: consent recorded with its own text version (`2026-11-selector-v1`, unknown versions refused), the answers on the request, campaign "selector" |
| Smoke | `docs/evidence/E3/smoke-log.txt`: 198 checks OK on a fresh demo (E2: 186), including the selector in Arabic. The selector answers with nothing approved (no figure, 0 of n shown), the founder verifies and approves one rule and one place from the Scoping page, the selector then shows that text and those figures and nothing else, and the review request is accepted |
| Screens | `83-public-selector-unapproved.png`, `84-public-selector-approved.png` (1280 px), `85-mobile-public-selector.png` (390 px, no horizontal overflow), `38-scoping-rules.png` (approve and withdraw controls). axe: 37 screens, 0 violations (`axe.json`) |

## Independent review

A separate reviewer read the whole diff before the pull request, with throwaway probes and no repository changes. It
found 4 must-fix leaks (all reproduced), 9 should-fix items and nits. All must-fix and should-fix items are fixed with
tests (D80 amended):
- **Must-fix.** Composite statements embedded unapproved rules' text; place-rule findings carried an unapproved
  place's figures; conclusions reached the public with nothing approved ("no option fits", rule keys on the page,
  `fail` outcomes); the founder approved a rule's summary while the public read the engine's wording.
- **Should-fix.** A stale rule kept its approval; UNCERTAIN renewal figures showed as checked; the consent record did
  not name the selector's text; queue status and the matrix size in this file were wrong; a vacuous assertion;
  Arabic stopped after the first question; a hidden answer was still sent; focus management; an unapproved place
  showed its authority and preferences.
- **Nits** fixed: one live approval per subject (unique index); the rules and places are loaded once per public
  assessment; restarting the selector resets the review form; the holding-company contradiction is gated on its
  rule; D80 says a rule of thumb is approvable.

## Could not verify

- **Whether any rule or figure is right.** Nothing is approved for public display until the owner's verifier and the
  founder approve it; the public sees "to be verified" until then.
- **The disclaimer wording** is a default for the owner and a lawyer to settle.

