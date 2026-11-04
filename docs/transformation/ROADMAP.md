# Transformation roadmap

The order of work under the owner's transformation mandate of 3 Nov 2026, reconciled with the outcome queue
(`outcomes/QUEUE.yaml`).

- Each line is one branch and one reviewed pull request, and the owner merges each one.
- It is updated with every outcome.
- The reasoning for the order is in `BASELINE-AUDIT.md`, sections 4 and 11.
- Status words are those of `IMPLEMENTATION-STATUS.md`.

## Principles

- Improve the existing platform with additive, backward-compatible changes only.
- Security and trust come before new capability. The AI agent is built on the existing engines, services, review
  queue and per-request roles, not beside them.
- Anything that needs an account, a credential, a regulator's or professional's sign-off, or money is built as far as
  it can go without it, behind an adapter with a test double. It stays BLOCKED or NOT LIVE until the owner supplies
  what it needs.
- No outcome claims more than its evidence shows.

## Outcomes

| Order | Outcome | Mandate | Business result | Status | Owner input |
| --- | --- | --- | --- | --- | --- |
| 1 | E17 Sign-in lockout | P0-01 (1.1) | Nobody can guess a sign-in code | TESTED, merged (camayank/mkw-uae-growth#38) | — |
| 2 | E18 Quote provenance | 2.4, 4.4 | Every quoted government fee says where it came from, in the same words everywhere, and keeps it | TESTED, merged (camayank/mkw-uae-growth#39) | partner-stated fees (gap 135); emirate-wide fees (gap 140) |
| 3 | E19 Role isolation and the runtime login | P0-01 (1.2) | Each party and each person sees only theirs. The app logs in as a role that owns nothing, and the audit trail is append-only at the database | TESTED, merged (camayank/mkw-uae-growth#40) | database roles within a party (T4, gap 142) |
| 4 | E20 Baseline audit and tracking documents | Phase 0 | A factual baseline and a plan everyone can check | IN PROGRESS | — |
| 5 | E21 Remaining isolation and state rules | P0-01 (1.2) | Every download is proven refused to another party, and every status change goes through one checked transition | NOT STARTED | — |
| 6 | E22 Upload quarantine | P0-01 (1.3) | A file is checked for what it really is and held until scanned; a failed or missing scan never counts as clean | NOT STARTED | the cost of running a live scanner (T6) |
| 7 | E23 Evidence operations | P0-02 (2.2) | Conflicting or changed facts are flagged to the verifier, and stale facts reach the ops queue | NOT STARTED | a named verifier for real data (gap 92) |
| 8 | E24 AI provider adapter | P1-01 (3.3) | A real model behind a budget, a timeout and schema checks, with the deterministic model kept as the fallback | NOT STARTED | provider, API key, monthly spending cap (T5) |
| 9 | E25 Agent tools and planning | P1-02 (3.2 A–C) | The agent reads a founder's goal, asks only what is missing, and builds a plan from the existing engines | NOT STARTED | — |
| 10 | E26 Agent execution and approval | P1-03 (3.2 D–F) | Agent runs persist, resume, stay within budget, and stop for a person at every consequential action | NOT STARTED | — |
| 11 | E27 Document intelligence | P1-04 (3.4) | Authorised uploads are read for type, fields and expiry, as a checklist for the reviewer | NOT STARTED | — |
| 12 | E28 Client journey | P1-05 (4.3, 4.4) | Documents are reused with consent, and the priority tier's speed is carried into the offer and the plan | NOT STARTED | — |
| 13 | E29 Agent evaluation and demonstration | P1-06 (3.5, 6) | 30 or more measured scenarios and a demo on synthetic data; `docs/competition/*` | NOT STARTED | — |
| later | Multi-activity, holding and India–UAE structures; three-year cost | P0-02 (2.3, 2.4) | Wider cases answered, or sent to a specialist with the reasons | NOT STARTED | verified figures |
| owner | O7 launch gate; O14 real payments and WhatsApp; O15 books and Arabic | P0-03, Phase 5 | Staging in the UAE region; live email, storage, payments and alerts; the pilot | BLOCKED | cloud account, domain, SES sender, payment provider, bank sample, WhatsApp, sign-offs |

E21 follows E20 under the mandate's standing instruction to continue with the next highest-priority outcome. The
owner can reorder or stop the work at any merge.

## Dependencies

```
E17 ─ E18 ─ E19 ─ E20 ─┬─ E21 ──────────────┐
                       ├─ E22 ─────────┐    │
                       ├─ E23          │    │
                       ├─ E24 ─┬───────┴─ E27
                       │       └─ E25 ─ E26 ─ E29
                       └─ E28
```

E25 needs E21 because agent tools must not change a status that no machine checks. E27 needs E22 because a document
is read only after it is scanned.

## What does not move without the owner

These wait for the owner:
- staging;
- live email, storage and payments;
- WhatsApp and the bank format;
- calendar booking;
- a live AI model and a live malware scanner;
- verified regulatory data;
- the pilot itself.

The code for each is built to the point where the owner's input is the only missing piece. `RELEASE-GATES.md` lists
what each gate needs.
