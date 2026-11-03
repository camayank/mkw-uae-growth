# E7E pilot journeys A to F

Six people walk the pilot: a founder on the public page, the adviser, the client, the partner firms, the founder of
MKW, and the person whose data the platform holds. `apps/api/test/pilot-journeys.test.ts` walks each path in order
over HTTP on one fresh environment (seeded, unverified catalogue; in-memory email, payments, storage and AI), so
the suite is one pilot day. The smoke test (`scripts/smoke.mjs`, `smoke-log.txt`) drives the same paths through
the screens. Nothing was sent, paid, released or filed; no real person's data was used.

Invariants asserted at every journey: **M** no money field of ours reaches the wrong party (partner cost, margin,
payout, rate card to a client; client price or margin to a partner; margin to ops) · **P** nothing is sent, paid,
released or filed without a person's action · **A** the audit chain verifies · **D** personal data is exportable and
erasable while payments, payouts and the audit chain survive · **B** branding (Tasees, by MKW Advisors to a client;
MKW Advisors to a partner).

| Journey | Steps (in order) | Test and smoke checks | Outcome on the seeded catalogue |
| --- | --- | --- | --- |
| **A. Founder** | Public assessment with nothing approved for display; result saved; preliminary report (PDF) downloaded; funnel events; review request with consent and a call request | Journey A; smoke 83–85, 92, 94–95 (homepage, questions, result, saved result, phone width), the E7D PDF check | Every statement "to be verified", no figure; the report says PRELIMINARY; one email to the founder (the sign-in), no marketing consent recorded as given; the lead and its request exist; chain intact. M P A B |
| **B. Adviser** | Lead with next best action "Assign an owner"; owner recorded; "Book the call they asked for"; call booked (consultation, follow-up queued); the client signs in and sees no advice; ops reads the advice (free zone, UNCERTAIN); a person approves; the client sees exactly that advice and downloads the reviewed report naming the reviewer | Journey B; smoke 86–88, 101–102 (leads, lead page, booked call), 36 and 81 (client advice, the reviewed PDF) | Advice held until approved; another client 404, a partner 403 on the report; nothing emailed by the adviser's actions; no outbox row; chain intact. M P A B |
| **C. Client** | Offers built (standard, priority) and published; the client reads prices, never partner cost; ops reads the offer without margin; proposal PDF branded Tasees and naming no partner; acceptance by the account owner; engagement awaits payment; no allocation before the deposit; finance records the transfer (ops may not); allocation starts; the funnel shows the pilot source from visit to acceptance once | Journey C; smoke 29–32, 75–78 (client home, proposal, timeline, phone width), 98–99 (funnel) | Unpublished offer 404 to the client; `clientUnitPrice` present and `partnerUnitCost` absent on every line; status awaiting_payment → allocating only after finance's action; funnel row visitors 1, leads 1, proposals 1, accepted 1, engagements 1. M P A B |
| **D. Partners** | Partner home without client price or margin; allocations accepted; the client's document checklist opens and is uploaded; each step: no submission without evidence, MKW QA before the client's approval; completion; payouts eligible; the partner's own cost visible, the client price never; one payout released only against the partner's invoice and by finance; the rest through a payout run (bank details, invoices, bank file, marked paid) | Journey D; smoke 10–13, 44–48, 93 (partner work, evidence, phone width), 33–34 (payout run, statement) | Submit without evidence 400; client approval before QA 409; release without invoice 409, by ops 403; run by ops 403; every paid amount carries a person's bank reference; all payouts released after the run; the bank file never says Tasees. M P A B |
| **E. Founder of MKW** | Dashboard (margin figures for founder and finance only; ops reads it without them; client and partner 403); the offer's margin to finance, not ops; coverage matrix; funnel totals; the accepted client absent from the attention list; System page staff-only; health; audit trail readable by staff, not by a client | Journey E; smoke 53–54, 70–71, 80, 96–99 (dashboard, command centre, system, coverage, funnel) | `seesMargin` true for the founder with `marginFils`, false for ops without it; every 403 as stated; chain intact after the whole day. M A |
| **F. PDPL** | Marketing consent withdrawn with how they told us; export of the founder's own data (their email in it, no partner cost or margin, nobody else's email); erasure refused to ops and done by the founder of MKW; user and lead tombstoned; payments, payouts unchanged; the chain longer and intact; the old session dead; the partner still reads the engagement without the person's email | Journey F; `pdpl.test.ts` (export, erasure, tampering), `lead-to-tasees.test.ts` (erasure of lead free text) | Consent history shows the withdrawal; export 200 with the person's data only; erasure 403 for ops, 200 for the founder; `status = erased`; payments and payouts byte-equal before and after; chain intact. D A |

## What the journeys do not do

- They do not reach staging, a real mailbox, a bank or a government portal: the adapters are the in-memory doubles
  (rule 7) and the catalogue is the seeded one with nothing verified (E2 is the owner's data and verifier).
- They do not prove the human parts of the gate: a lawyer's terms, a tax adviser's layout, an outside security review,
  three signed partner firms and five consenting clients (`GO-NO-GO.md`).

## Found while walking them

- None of the journeys needed a product change. Two of the suite's own first-draft assumptions were wrong and are
  recorded here so nobody repeats them: the client's document checklist opens when the partners accept the
  allocation, not at the client's acceptance; and a payout run collects eligible payouts that carry an invoice and
  bank details, while a single release is a separate, finance-only action against one invoice.
