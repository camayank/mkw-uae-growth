# Tasees platform

The operating system for **Tasees, by MKW Advisors**: a managed marketplace for UAE business services
(company setup, visas, banking, PRO, accounting, tax, audit, compliance). Clients buy from MKW Advisors at
one clear price. Vetted partner firms in the **MKW Advisors Partner Network** deliver the work. MKW Advisors
sets the scope and price, picks the partner, checks the evidence and pays the partner. Every step is on record.

```
client request ──► scope sheet ──► partner prices (rate cards or sealed quotes)
      ──► normalised cost ──► margin rule ──► up to 3 offers (essential / standard / priority)
      ──► client accepts + pays deposit ──► allocation (eligibility, fairness cap, margin protection)
      ──► partner accepts within 4 working hours ──► milestones: evidence → MKW check → client approval
      ──► staged partner payouts (40 / 40 / 20) ──► hash-chained audit trail
```

## Quick start

Needs Node 22 and pnpm 10.

```bash
pnpm install
pnpm seed          # catalogue, margin rules and demo parties (invented firm names) into ./apps/api/data/pglite
pnpm dev           # http://localhost:8787 with development sign-in (codes shown on screen)
pnpm test          # 196 tests: pricing, allocation, rules, full HTTP flow, database security, admin, PDPL, storage
pnpm typecheck
pnpm build         # compiles to dist/; `pnpm start` then runs the compiled build (what production and the Dockerfile run)
npx playwright install chromium && pnpm smoke   # browser smoke test against a running demo; screenshots in ./smoke-shots
TEST_DATABASE_URL=postgres://... pnpm test       # the same suites on a real Postgres server
```

No database server is needed for development: the API runs an embedded Postgres (PGlite) on disk.
Set `DATABASE_URL` to use a real Postgres.

### Demo accounts (development only)

| Who | Email | Sees |
| --- | --- | --- |
| Client owner | founder@sample-client.test | Requests, offers, accept, approvals, payments |
| Client member | accounts@sample-client.test | Same, but cannot accept offers or change orders |
| Partner admin | admin@setup-partner.test | Offered work with its payout, steps, rate card, payouts |
| Partner admin | admin@corporate-services.test | (pilot partner, banking and PRO) |
| Partner admin | admin@tax-accounts.test | (FTA tax agent, approved auditor) |
| MKW ops | ops@mkwadvisors.test | Everything **except margin** |
| MKW finance | finance@mkwadvisors.test | Margin, payments received, payout release |
| MKW founder | founder@mkwadvisors.test | Everything |

A full walk-through: sign in as the client → **New request** → as ops, **Pipeline → Price it → Open → Publish**
→ as the client, accept → as finance, **Mark received** on the deposit → as each partner, **Accept** →
as the partner, upload evidence and **Submit** → as ops, **Evidence is right** → as the client, **Approve**.
As the founder: **People** creates partner firms and users, changes roles, deactivates, exports or erases a
person's data (UAE PDPL); **Settings** confirms retention periods.

## Layout

```
packages/core     Pure domain logic, no I/O. Money in integer fils, rates in basis points.
  money.ts          aed(), basis points, rounding, largest-remainder splits
  normalise.ts      comparable cost = fee + govt fee (platform table) + gap cost + third party + risk loading
  select.ts         selection score (cost 40 / speed 30 / quality 15 / capacity 15) and tier picks
  pricing.ts        price = max(cost × (1+m), cost + floor) ↑ AED 50, capped at 1.25 × market mid; VAT; payment plan
  allocation.ts     eligibility, partner-sourced lock, relationship, quoting partner, 35% fairness cap, margin protection
  sla.ts            UAE working hours and days (Mon–Fri 09:00–18:00 GST)
  states.ts         offer, engagement and milestone state machines
  visibility.ts     field classes (public / client / partner / internal / finance), deny by default
  masking.ts        hides phone numbers and emails in client–partner messages
  scope.ts          intake answers → scope lines and milestone templates
  advice.ts         structure, place, licence and obligation advice, each item as confident as its rule (O5)
  scorecard.ts      partner quality score, service-guarantee credit and client document checklists (O6)
  reporting.ts      reporting periods, rates, CSV lines (O8)
  obligations.ts    compliance calendar rules: which services create which recurring obligations (O8)
apps/api          Fastify 5 + zod + Postgres (pg in production, PGlite in dev and tests)
  migrations/       schema, roles, row-level security, column grants, hash-chained audit function
  src/services/     pricing, engagements (allocation, milestones, payouts, change orders, RFQs), views
  src/jobs/         timers: partner reply deadlines, client auto-approval, offer expiry
  src/services/admin.ts  organisations, people, PDPL export and erasure, retention settings
  src/lib/storage.ts     evidence files: memory (tests), local disk (development), S3-compatible bucket (production)
  src/lib/notify.ts      notifications: recorded in the database, delivered by memory/console/Amazon SES transports
  src/lib/templates.ts   the eleven message templates, branded by audience
  src/services/rules.ts  margin rule versions with effective dates, pricing settings, government fee table
  src/services/invoices.ts  tax invoices, credit notes, statements; src/lib/pdf.ts writes the PDFs
  src/services/payouts.ts   partner invoices, payout runs, bank bulk-transfer file; src/lib/payments.ts the card provider adapter
  src/services/scoping.ts   scoping rules and zones with sign-off, advice review and approval, search
  src/services/drafts.ts    the AI review queue; src/lib/ai.ts the model adapter with its in-memory double
  src/services/intake.ts    public intake with PDPL consent (apps/web/public/intake.html posts here)
  src/services/partners.ts  onboarding pipeline and documents, licence watch, scorecards, partner staff (O6)
  src/services/delivery.ts  client document requests, delay watch and guarantee, ratings, manual allocation, offer PDF (O6)
  src/services/reporting.ts founder and partner dashboards, accounting export (O8)
  src/services/compliance.ts client obligations with confirmation, evidence, reminders (O8)
  src/db/catalogue.ts    the 62 catalogue codes added to the 20 starter codes (83 Service Catalogue rows)
  src/scripts/      seed, run-jobs, import-sheet (rate cards from the operating Google Sheet), verify-audit
  test/             end-to-end HTTP flow, exceptions, database security, admin, PDPL, storage adapters
scripts/          smoke.mjs (browser smoke test), backup.sh, restore-drill.sh
.github/workflows CI: typecheck, tests, compiled build, smoke test against the compiled build, container image
apps/web/public   The web app: plain HTML, CSS and ES modules, no build step. Served by the API.
docs/             DEPLOY.md, DECISIONS.md, KNOWN-GAPS.md
```

## How the money stays private

Three layers, each enough on its own to stop a leak:

1. **Database.** Client and partner reads run under the `app_client` / `app_partner` Postgres roles with
   row-level security (only rows of their own organisation or engagement) and column grants. A client session
   selecting `margin_fils` or `partner_unit_fils` gets `permission denied`; so does a partner selecting
   `client_unit_fils`. Tested in `apps/api/test/security.test.ts`.
2. **Serialisation.** Every response passes through the field visibility map in `packages/core/src/visibility.ts`.
   Fields not listed are dropped. Ops never sees margin; finance and the founder do.
3. **Messages.** Phone numbers and emails are masked between client and partner; MKW sees the original.

Writes run as `app_platform` after the route has authorised the user in code. Every state change appends an
event to `audit_events`, chained by SHA-256 with the previous event.

## Pricing and allocation rules

They match the **Deliverable Codes**, **Rate Cards** and **Offer Builder** tabs of the operating Google Sheet;
`packages/core/test/pricing.test.ts` reproduces the Sheet's worked example to the fils.

- Reseller lines: the client pays MKW's price; the partner is paid its cost. Agent lines (FTA tax agency,
  statutory audit, liquidation): the licensed firm's fee plus a disclosed MKW fee = max(cost × m, floor).
- A line whose cap would push margin below the floor goes to ops review instead of being published.
- Allocation never offers work to a partner whose own cost for those lines is above the cost the client's
  price was built on (margin protection). If nobody qualifies, the line goes to the ops queue.
- Client pays 50% of fees + all government fees on acceptance, the rest on completion.
  Partners are paid 40% at kick-off, 40% at the key milestone, 20% on completion, and only from money received.

## Further reading

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md): the base product: modules, rules, data model, build plan
- [`outcomes/QUEUE.yaml`](outcomes/QUEUE.yaml): the build queue; work only on the released outcome
- [`CLAUDE.md`](CLAUDE.md): rules for contributors and coding agents

- [`docs/DEPLOY.md`](docs/DEPLOY.md): environment variables, Postgres, object storage, hosting in the UAE, jobs, backups
- [`docs/RESTORE-DRILL.md`](docs/RESTORE-DRILL.md): how backups are proven restorable, and the drill log
- [`docs/DECISIONS.md`](docs/DECISIONS.md): why it is built this way, and the decisions still open for the owner
- [`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md): what is not built yet, in priority order

Statutory and fee data in the catalogue are working estimates, not verified rules. They must be checked by a
qualified person before the platform quotes real clients; where the system is unsure it must say so.
