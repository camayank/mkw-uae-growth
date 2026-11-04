# Transformation decision log

Decisions about how the transformation is run, numbered T1, T2 and so on. Product and engineering decisions stay in
`docs/DECISIONS.md` (D-records), which remains authoritative; a T-record that changes the product points to its
D-record. Open decisions say who decides and what each option costs; nothing open is acted on until decided.

## Decided

**T1. The mandate's work continues the E-series of outcomes.** (E18, 4 Nov 2026.) The mandate suggests P0-01 to P1-06;
the repository already numbers outcomes E1 to E17. New outcomes take the next E-numbers (E19 onwards), and
`ROADMAP.md` maps each to its mandate item. One numbering keeps `outcomes/QUEUE.yaml` the single queue.

**T2. Status words are the mandate's seven, with stated evidence; no completion percentage.** (E18.)
`IMPLEMENTATION-STATUS.md` defines NOT STARTED to PRODUCTION VERIFIED and the evidence each needs. A percentage would
need an agreed method; none exists, so none is given.

**T3. Security hardening comes before the AI agent.** (E18.) The baseline audit found the audit trail editable by the
application's own database role and some role paths untested (`BASELINE-AUDIT.md` 4.1, 4.2). An agent that acts on
behalf of users must inherit limits that are proven first, so E19 and E20 precede E22 to E24.

## Open (owner)

**T4. Separate database roles for ops and finance?** Today ops, finance and the founder share one database role
(`app_platform`), so "ops never sees margin" is enforced at the routes and the visibility map, not at the database.
- **A. Split the role.** `app_ops` without grants on margin columns and tables; `app_finance` for finance and the
  founder. Restores three layers for this pair. Cost: a migration touching every platform grant and every
  `asPlatform` call site; the largest change E19 could carry. Same question for partner staff vs admin.
- **B. Keep one role and record the exception.** Two layers (route guard and visibility map) plus tests for every
  path. Cost: none now; the rule in CLAUDE.md is then stated as two layers for within-party pairs.

Recommendation: B in E19 with full tests, and A as a later outcome if the outside security reviewer asks for it.
Decides: the owner.

**T5. Which AI provider, with what monthly cap?** `lib/ai.ts:213` names `AI=anthropic` as the intended adapter; the
mandate asks for a real provider with spending limits. Needed before E22 can call a live model: the provider, an API
key in the secrets store (never in code or chat), a monthly cap in AED, and whether personal data may be sent
(PDPL; the provider's region and retention terms). Until then E22 builds the adapter against a test double and the
screen says "AI: not connected". Decides: the owner.

**T6. A live malware scanner?** E20 builds quarantine and a scanner adapter with a test double, and refuses downloads
until a file is clean. A live scanner (for example ClamAV as a side task in the staging stack, or a managed service)
costs money to run. Until decided, uploads in staging stay quarantined, or the owner accepts "not scanned" as an
explicit, labelled state for the pilot. Decides: the owner.

**T7. O16 "Agents round two" and E22–E24.** O16 (planned) lists a fee and rule watcher, a compliance calendar agent, a
vetting assistant and a founder analyst. E22–E24 build the provider, the tool registry, the run store and approvals
those agents need. Proposal: O16 keeps the specific agents and depends on E24. Decides: the owner, at O16's release.
