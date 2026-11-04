# Transformation roadmap

The order of work under the owner's transformation mandate of 3 Nov 2026, reconciled with the existing outcome queue
(`outcomes/QUEUE.yaml`). Each line is one branch and one reviewed pull request; the owner merges each one. Updated with
every outcome. The reasoning for the order is in `BASELINE-AUDIT.md`, sections 4 and 11.

Status words are those of `IMPLEMENTATION-STATUS.md`.

## Principles

- Improve the existing platform; additive, backward-compatible changes only.
- Security and trust before new capability; the AI agent is built on the existing engines, services and review queue,
  not beside them.
- Anything that needs an account, a credential, a regulator's or professional's sign-off, or money is built as far as
  it can be without it, behind an adapter with a test double, and marked BLOCKED or NOT LIVE until the owner supplies it.
- No outcome claims more than its evidence shows.

## Outcomes

| Order | Outcome | Mandate | Business result | Status | Owner input |
| --- | --- | --- | --- | --- | --- |
| 1 | E17 Sign-in lockout | P0-01 (1.1) | Nobody can guess a sign-in code | TESTED, merged (camayank/mkw-uae-growth#38) | — |
| 2 | E18 Baseline audit and tracking documents | Phase 0 | A factual baseline and a plan everyone can check | IN PROGRESS | — |
| 3 | E19 Role isolation and audit guard | P0-01 (1.2) | Every role's limits proven by a test, within a party as well as across; the audit trail cannot be edited by the application | NOT STARTED | choose option A or B for platform database roles (`DECISION-LOG.md` T4) |
| 4 | E20 Upload quarantine | P0-01 (1.3) | A file is checked for what it really is and held until scanned; a failed or missing scan never counts as clean | NOT STARTED | running a live scanner costs money (T6) |
| 5 | E21 Evidence operations | P0-02 (2.2) | Conflicting or changed facts are flagged to the verifier; stale facts reach the ops queue | NOT STARTED | a named verifier for real data (gap 92) |
| 6 | E22 AI provider adapter | P1-01 (3.3) | A real model behind a budget, a timeout and schema checks, with the deterministic model kept as fallback | NOT STARTED | provider, API key, monthly spending cap (T5) |
| 7 | E23 Agent tools and planning | P1-02 (3.2 A–C) | The agent reads a founder's goal, asks only what is missing and builds a plan from the existing engines | NOT STARTED | — |
| 8 | E24 Agent execution and approval | P1-03 (3.2 D–F) | Agent runs persist, resume, stay within budget and stop at every consequential action for a person | NOT STARTED | — |
| 9 | E25 Document intelligence | P1-04 (3.4) | Authorised uploads are read for type, fields and expiry, as a reviewer's checklist | NOT STARTED | — |
| 10 | E26 Client journey | P1-05 (4.3, 4.4) | Documents reused with consent; the priority tier's speed carried into the offer and the plan | NOT STARTED | — |
| 11 | E27 Agent evaluation and demonstration | P1-06 (3.5, 6) | 30+ measured scenarios and a demo on synthetic data; `docs/competition/*` | NOT STARTED | — |
| later | Multi-activity, holding and India–UAE structures; three-year cost | P0-02 (2.3, 2.4) | Wider cases answered or sent to a specialist with reasons | NOT STARTED | verified figures |
| owner | O7 launch gate; O14 real payments and WhatsApp; O15 books and Arabic | P0-03, Phase 5 | Staging in the UAE region, live email, storage, payments, alerts, pilot | BLOCKED | cloud account, domain, SES sender, payment provider, bank sample, WhatsApp, sign-offs |

E19 follows E18 under the mandate's standing instruction to continue with the next highest-priority outcome. The owner
can reorder or stop at any merge.

## Dependencies

```
E17 ─ E18 ─┬─ E19 ─────────────┐
           ├─ E20 ─────────┐   │
           ├─ E21          │   │
           ├─ E22 ─┬───────┴─ E25
           │       └─ E23 ─ E24 ─ E27
           └─ E26
```

E23 needs E19 because agent tools must inherit the tested role limits. E25 needs E20 because a document is read only
after it is scanned.

## What does not move without the owner

Staging, live email, live storage, live payments, WhatsApp, the bank format, calendar booking, a live AI model, a live
malware scanner, verified regulatory data and the pilot itself. The code for each is built to the point where the
owner's input is the only missing piece; `RELEASE-GATES.md` lists what each gate needs.
