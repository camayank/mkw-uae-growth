# U1 Client and partner workspace redesign

Status: verified-pending-merge (branch `outcome/U1-workspace-redesign`; released by the owner on 3 Nov 2026: "now build these
designs into the web app", after the design canvas and its review round of the same day)

## Business result

A client opens Tasees and sees the one thing that needs them, with the date something happens if they do nothing;
reads the advice as two sentences before the reasoning; sees one offer with its other options as a switch; and works an engagement
from a short page where documents, steps and payments fold away until needed. A partner sees the work offered with
the four facts the decision needs and a reply countdown, and works an engagement from its next step. Both work on a
phone with a tab bar. Nothing a role could not see before becomes visible.

## Scope

1. **Client overview** (`renderClientHome`): the next action first with its due date and the other open items under
   it; the engagement card with progress; a Money card from the statement totals; requests and offers; the next
   compliance dates; the advice table as today.
2. **Advice page** (`renderRequest`, client branch): an "In short" card (one plain sentence, why, and the points to
   confirm before quoting) above the full reasoning, which sits in one collapsible panel, open by default.
3. **Offer page** (`renderClientOffer`): one offer shown as selected, the other published tiers as a switch, with
   tier names from one map, none promising a pace; the proposal sections as today.
4. **Client engagement** (`renderClientEngagement`): the next action and messages above the fold; documents (open
   while any is outstanding), steps, payments, guarantee credits, rating, scope changes and what was bought as
   collapsible panels whose headings carry their state.
5. **Partner work page** (`renderPartnerHome`): the pilot notice as a badge line; the offered table reduced to where,
   what, payout, reply-by with a countdown, and the two buttons; in delivery with the status.
6. **Partner engagement** (`renderEngagement`, partner branch): the next step with its evidence upload as the first
   card, messages beside it; steps, scope and fees, client documents, payouts and scope changes as panels.
7. **Partner firm and rate card**: scorecard bars from the latest scorecard; expiry badges on documents; an expired
   badge on rate cards past their validity.
8. **Phone tab bar**: for clients and partners at 640 px and below, the menu becomes a bottom tab bar with icons; MKW
   staff keep the grouped menu.
9. **Arabic**: dictionary and pattern entries for every new client-facing string (draft, under the existing reviewer
   gate). Partner screens stay English, as today.

## Exclusions

- No API change and no new data: every figure shown comes from endpoints the role already reads.
- No change to how ops builds offers or which tiers exist; tier names are labels on the client's screen only.
- No Arabic for partner screens (O15); no dark-mode work beyond what the tokens already give.
- The ops and finance screens are untouched, including their view of an engagement.

## Acceptance evidence

- `pnpm test` and `pnpm typecheck` pass (no API change; the suites prove nothing regressed).
- The browser smoke test passes on a fresh demo with its existing checks and new ones: the "In short" card on the
  advice; the offer switch names no pace; the client engagement folds its panels and keeps the pinned action and timeline;
  the partner engagement opens on the next step and still hides client prices; the phone tab bar at 390 px for a
  client and a partner; axe clean on every new screen at 1280 and 390 px; no string U1 added is reported untranslated
  on the client screens visited in Arabic.
- Screenshots of each changed screen at 1280 and 390 px under `docs/evidence/U1/`.

## Dependencies and risks

- Depends on E6 (merged). The design canvas (claude.ai, 3 Nov 2026) is the reference; `docs/DESIGN.md` records the
  patterns so the canvas is not needed to maintain the code.
- Risk: the smoke test drives the partner's evidence form by position in the steps list; moving the form into the
  next-step card changes those selectors. The smoke test is updated with the screens, never weakened.

## Owner decisions

- None to merge. Whether ops should stop building the "essential" tier is a product decision; the screen handles any
  number of tiers.
- **Ask-me: how government fees are settled with partner firms.** The partner screens now say only that government
  fees are not part of the payout figure, because nothing in the repository or the partner agreement says whether a
  firm pays the authority and is reimbursed against the receipt or MKW pays directly. The review removed a sentence
  that assumed the first. The answer belongs in the partner agreement (O7 lawyer sign-off) and then on the screen.

## Rollback

- Revert the pull request: web files, the smoke test and documents only.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm typecheck` clean; `pnpm test`: 105 core + 333 API (1 skipped on PGlite) = 438, unchanged: no API change; rerun after the review fixes |
| Smoke | `docs/evidence/U1/smoke-log.txt`: 221 checks OK on a fresh demo (E6: 213), the 8 new ones marked U1 (the eighth reads the Arabic gap list after the review): the partner's offer row carries a reply countdown and no client price; the partner's next step is pinned with its evidence upload; the client engagement opens on the next action and folds the rest into panels; the client and partner menus are bottom tab bars at 390 px; the advice opens with a plain summary before the reasoning; axe on the partner's work page at 390 px |
| Accessibility | `axe.json`: 41 screens at 1280 and 390 px, 0 violations |
| Screens | `36-client-advice.png` (In short above the reasoning), `13-client-engagement-approved.png` (next action, messages, panels), `07-client-offer.png`, `11-partner-engagement.png` (pinned next step), `10-partner-offered-work.png` (countdown), `75-mobile-client-home.png` and `93-mobile-partner-work.png` (tab bars at 390 px), `81-mobile-client-advice.png` |
| Audit chain | `pnpm verify:audit` on the smoke demo: intact |
| Patterns | `docs/DESIGN.md` rows marked U1; D84; KNOWN-GAPS 81–84 |

## Independent review

Two reviews of the diff at 2925d7e, both applied in the commit that follows it:

- **Codex (PR 23, P2):** "Faster" promised a pace the plan does not keep: the priority tier is priced on the quote
  with the fewest working days, but offer lines do not store them, so the proposal's estimate and the milestone dates
  come from the scope templates for every tier. Fixed by keeping the name "Priority", dropping the pace sentence from
  the offer switch, and recording gap 85; the Arabic entries and the smoke check follow.
- **Independent review agent (must-fix):** (1) toasts painted under the phone tab bar, since `#toast` had no z-index:
  fixed, with the toast lifted above the bar for clients and partners; (2) "In short" could argue for a structure
  other than the one it named, because it took the first reason while the engine appends the reason for moving away
  from the preferred or requested structure: fixed, the summary now shows that reason when one exists; (3) the partner
  work page said the client's name and contact details appear once the engagement opens, which rule 9 forbids: fixed,
  the sentence now says the brief and steps open and contact details stay hidden.
- **Should-fix, all applied:** the summary counted at most two points to confirm and called that the total (counts
  before slicing now); "government fees reimbursed at cost against the receipt" was an unverified claim (removed;
  Ask-me above); "accepted <date>" on the partner engagement used the client's acceptance date (now "opened"); the
  outcome claimed an Arabic-gap smoke check that did not exist (added: the gap list the reviewer sees, read after the
  client screens are visited in Arabic, must hold none of the strings U1 added; the older strings it does hold are
  gap 87); the offer chip on the client home lacked an Arabic pattern (added);
  two smoke checks could not fail (tightened: the points to confirm are between one and two, and the partner row must
  carry the payout wording).
- **Not changed, recorded:** the partner's "Ask the client" form sits in the documents panel, open only while a
  document awaits them (discoverability; pre-existing placement); the browser tab title reads "… · Tasees" for every
  signed-in role, including partners, which pre-dates U1 (gap 86); the `work` option of `milestoneActions` is never
  passed as false (kept for the ops view, which the next outcome may use).

## Could not verify

- **How real founders and partner firms read the new pages**: the pilot will tell; the screens were tested by rule
  and by the browser suite, not by people.
- **The offer switch with several published tiers** in the browser: the demo builds one published offer, so that path
  is covered by the markup and the conditional smoke check only.

