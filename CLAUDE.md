# Tasees platform: operating contract for contributors and coding agents

Tasees, by MKW Advisors, is a managed marketplace for UAE business services. MKW Advisors sells at one
price; vetted partner firms in the MKW Advisors Partner Network deliver; MKW controls scope, price,
allocation, quality and payment. The product specification is `docs/PRODUCT_SPEC.md` (diagrams in `docs/img/`); read it first.
`README.md`, `docs/DECISIONS.md`, `docs/KNOWN-GAPS.md` and `docs/DEPLOY.md` are authoritative.
`BUILD_PROMPT.md` is the full standing contract (business, rules, method, queue, quality bar, launch gate, Ask-me
list); this file is its short operational version. When a rule changes, change both in the same commit.
`docs/VISION.md` says where the product is going (journeys, agents, architecture, roadmap O10 to O15).
Working code and passing tests are assets: extend them, never rewrite them opportunistically.

## How work is done

- Work only on the released outcome in `outcomes/QUEUE.yaml` (the first with `status: released`).
  Before coding, write or complete its contract in `outcomes/<id>.md`: business result, scope, exclusions,
  acceptance evidence, dependencies, risks, owner decisions, rollback.
- One short-lived branch per outcome, one reviewed pull request. Never commit straight to `main`.
- For every behaviour change: build → run → test → observe → compare → diagnose → repair → retest.
- An outcome is done only when: tests pass (`pnpm test`), typecheck is clean (`pnpm typecheck`), the
  browser smoke test (`scripts/smoke.mjs`) passes against a fresh demo, new screens are screenshotted at
  desktop and phone width, and the evidence paths are listed in the outcome file. Then set its status to
  `verified-pending-merge` and stop. The owner merges and releases the next outcome.
- Update `docs/KNOWN-GAPS.md` and `docs/DECISIONS.md` in the same pull request.

## Rules that never bend

1. **Privacy of money.** Clients never see partner cost, margin or payouts; partners never see client
   price, margin or other partners' quotes; MKW ops never sees margin (finance and founder do). Enforce in
   three layers: Postgres row-level security and column grants, the field visibility map in
   `packages/core/src/visibility.ts`, and tests that try to read each forbidden field as each role.
2. **One margin rule** (`packages/core/src/pricing.ts`) prices offers, change orders and re-allocations.
   A line below the floor goes to ops review. Allocation never pays a partner above the priced cost.
3. **Money is integer fils; rates are basis points.** No floating point in money.
4. **Done means evidenced.** A milestone closes only with its required evidence, an MKW check and client
   approval (or the auto-approval rule).
5. **Uncertain is a state.** Unverified fees, statutory rules and AI output are labelled UNCERTAIN and cannot
   reach a client without a person's approval. No automatic statutory conclusions or filings, ever.
6. **No unattended side effects.** Nothing is sent, paid, released or filed without a person's action or an
   explicit, tested rule. AI produces drafts into a review queue.
7. **External services sit behind adapters** with an in-memory test double (email, payments, storage, AI,
   WhatsApp, bank files). Tests never call the internet.
8. **Append-only audit.** Every state change writes a hash-chained audit event. Never edit or delete audit rows.
9. **Personal data (UAE PDPL).** Collect consent at intake, keep data in a UAE region, mask contact details
   between parties, support export and erasure while keeping what tax law requires.
10. **Branding.** Clients see "Tasees, by MKW Advisors". Anything addressed to a partner comes from
    "MKW Advisors" / "MKW Advisors Partner Network" and never uses the name Tasees on its own.
11. **Dependencies.** Prefer the standard library and what the repo already uses. Before adding a library,
    record in `docs/DECISIONS.md` why, its licence, maintenance, security and how to remove it. Pin exact versions.
