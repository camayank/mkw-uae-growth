# E18 Trusted quotation: each government fee keeps the evidence it was quoted on

Status: merged (camayank/mkw-uae-growth#39, 4 Nov 2026; previously verified-pending-merge, branch `outcome/E18-quote-provenance`, on `main` at d8104fb with E17 merged; released
by the owner on 4 Nov 2026: "Execute E18: trusted quotation and fee provenance… Complete this one outcome thoroughly
before beginning the next major enhancement.")

## Business result

MKW Advisors is accountable for the quotation a client accepts. After E18, every government fee on an offer says where
its figure came from, in the same words online, in the downloadable offer and in the record of what the client
accepted. Nothing that happens to MKW's fee table afterwards (a fee recorded, verified, retired or replaced) changes
what the client was told about a quotation already given.

## The defect, reproduced first

Four tests (`apps/api/test/fee-provenance.test.ts`, the first `describe`) were written before any fix and run against
`main` at d8104fb. All four failed (`docs/evidence/E18/before-fix.txt`):

1. **A partner-stated fee lost its disclosure** once MKW recorded and verified a fee for that service after the offer
   was published. The proposal looked the fee table up again whenever it was read (D60), found a verified row and
   dropped the estimate note, although the quoted amount was still the partner's figure.
2. **An unverified fee lost its estimate note** once the record was verified after publication, for the same reason.
3. **The downloadable offer said nothing about a fee's source.** Its assumptions said government fees were "as
   published on the offer date", which a partner's figure is not.
4. **An ops price change cleared a fee decision.** Setting a line's price marks the line `ok`, so an UNCERTAIN fee
   on that line could be published without anyone acknowledging it.

Found while fixing and also fixed: the offer PDF's longer lines ran off the page's edge and were lost (the payment,
timeline, included and assumptions paragraphs), and its dates printed without the year ("Mon Oct 19").

## Scope

1. **Snapshot** (migration `023_fee_provenance.sql`, additive). Each offer line records, when it is priced:
   - the fee's basis (`verified`, `partner_stated`, `uncertain`, `stale`);
   - the fee record used (`gov_fee_id`), the emirate and free zone, the source link;
   - who verified it and when, and the quotation date;
   - whether a person must acknowledge it (`gov_fee_review`), and who did and when.

   The quoted amount (`gov_unit_fils`) and the service code were already on the line. A trigger refuses any later
   change to the amount or the evidence. The only change allowed is a person's acknowledgement, from `required` to
   `acknowledged`, with who and when, once.
2. **One disclosure** (`packages/core/src/fee-disclosure.ts`): `feeBasis`, `feeNeedsReview`, `feeLabel`,
   `feeDisclosure`. It gives VERIFIED, PARTNER-STATED, UNCERTAIN, STALE or LEGACY, each with one client sentence. It
   is read through `loadFeeDisclosures` (`apps/api/src/services/repo.ts`) by:
   - the client's online proposal (`clientOfferProposal`: `feeDisclosures`, plus `feeNotes` kept for older pages);
   - the downloadable offer (`offerDocument`);
   - the acceptance record (the `offer.accepted` audit event carries the disclosures accepted);
   - MKW's offer review (`opsOffer`: a "Government fee" column with the evidence);
   - the `offer.built` and `offer.published` audit events.
3. **Publication** (`publishOffer`). A line whose fee needs a decision stays flagged after an ops price change, and
   the acknowledgement is written on the line. The offer's "lines needing a decision" count includes it.
4. **Screens.**
   - The client's proposal lists each fee with its label and sentence. "Before you accept" says how many fees are
     estimates.
   - The ops offer review has a government-fee column: label, amount, where it came from, who verified it and when,
     the quotation date, the source link, and whether it needs or has an acknowledgement.
5. **The offer PDF.** Each fee gets its label and sentence. The assumptions say only a VERIFIED fee was checked against
   the authority's figure. Paragraphs are wrapped to the page, and dates are ISO.
6. Draft Arabic for the labels and sentences (gap 138). D100, gaps 135–139, the product spec, the queue (E17 merged).

## Exclusions

- **No change to prices, the margin rule, VAT, the deposit, partner selection, publication or acceptance rules.** The
  fee amount on an offer is the same figure as before.
- **Partner-stated fees still publish without an acknowledgement**, the existing rule. The recommendation is recorded
  in D100 and gap 135, not applied.
- **Labels on the engagement page, invoices and payments** (gap 137).
- **An archived copy of the authority's page** (gap 139).

## Acceptance evidence

`docs/evidence/E18/`:

| Check | Result | File |
| --- | --- | --- |
| The four reproductions on the old code | 4 failed | `before-fix.txt` |
| `pnpm typecheck` | clean | `tests-pglite.txt` |
| `pnpm test` (PGlite) | core 159 passed (19 files); API 396 passed, 1 skipped (39 files) | `tests-pglite.txt` |
| API suite on PostgreSQL 16 | 397 passed (39 files), including the PostgreSQL-only test; the new file and the concurrency tests listed verbose (32) | `tests-postgres16.txt` |
| `pnpm build` | exit 0 | `build.txt` |
| Browser smoke on a fresh demo | 330 checks, 0 failed (4 new for E18), axe on the new phone screen | `smoke-log.txt` |
| Screens | the client proposal (desktop `72`, phone `78`), the ops offer with the fee column (desktop `05`, phone `79`), finance's view (`06`) | `screens/` |
| Synthetic sample offers | VERIFIED with PARTNER-STATED; UNCERTAIN with STALE (PDF and first page) | `sample-offer-*.pdf`, `*-1.png` |

The twelve scenarios (`fee-provenance.test.ts`, second `describe`):

1. partner-stated fee without a record;
2. current verified fee;
3. unverified fee, refused without an acknowledgement, the acknowledgement recorded and immutable;
4. stale verified fee;
5. record created after publication;
6. record retired and replaced after publication, with direct rewrites refused;
7. offer accepted before the table changes;
8. PDF against the online proposal, byte for byte after a table change, every line within the page;
9. historical offer without provenance (LEGACY, no back-fill);
10. unauthorised access (client gets label and sentence only, no evidence columns at the database, partners 403,
    ops without margin);
11. concurrent publication;
12. audit and money reconciliation (line fees sum to the offer, deposit plus balance equals the total, the audit
    events carry the evidence, the chain verifies).

Scenarios 5 and 8 share one test.

## Security review

- **Money privacy (rule 1):**
  - the evidence columns are not granted to `app_client` (scenario 10 reads them as the client at the database and
    is refused);
  - the client's offer JSON carries the label and sentence only;
  - partners get 403 on the client offer, its PDF and MKW's review;
  - ops see the evidence and still no margin.
- **Audit (rule 8):** `offer.built`, `offer.published` and `offer.accepted` record the fee evidence and disclosures;
  the chain verifies (scenario 12).
- **Integrity:** the trigger refuses rewriting a quoted fee or its evidence, even by the platform role (scenarios 3, 6
  and 9).
- **Uncertain is a state (rule 5):**
  - no line is shown as verified unless a verified, current record was used when it was priced;
  - a line priced before E18 is LEGACY, never verified.
- **Web:** every value is escaped. The source link is shown only for `http(s)` addresses, with
  `rel="noopener noreferrer"`.

## Independent review

An independent reviewer read the diff and probed it on PGlite and PostgreSQL 16. Found and fixed, each with a test in
the third `describe` of `fee-provenance.test.ts`:

- **(Blocking) An unverified fee of zero escaped the acknowledgement and the disclosure.** The review now follows the
  basis whatever the amount; such a line is disclosed as UNCERTAIN or STALE, on the screen and in the PDF.
- **A price set at the moment of publication could land on the published offer.** This predates E18 and is in the
  code it touches. Setting a price now takes the audit lock and locks the offer row first, as publication does.
- **Ops could read margin in the audit trail** (rule 1). This predates E18; the `offer.built` event E18 rewrote
  carries it. The trail is now shown to ops without margin figures; the stored events and hashes are unchanged.
- **A fee verified at pricing but over 90 days old at publication** now needs an acknowledgement, recorded in the
  audit event.
- **A catalogue figure with no fee record** is UNCERTAIN, not PARTNER-STATED.
- **The guard** also freezes the line's offer, code and quantity, refuses stray acknowledgement fields, and refuses
  deleting a line.
- **The evidence dates on MKW's review** are the database's text, so they are right east of UTC.
- The "lines needing a decision" count after a price change is now asserted (the "Publish anyway" button).

Recorded, not changed:
- the free-zone and emirate-wide question is an owner decision (gap 140);
- the verifier's name is kept on the frozen line (gap 141).

## Codex review

- **A verified fee that went past 90 days between pricing and publication made Publish refuse forever on the screen.**
  The stored "lines needing a decision" count stayed at 0, so the button sent no acknowledgement and every click got
  409. Fixed with a test: MKW's offer view counts such lines by the same test publication applies, so the screen
  offers "Publish anyway" and the acknowledgement goes through.

## Dependencies

E17 (merged). Builds on D22b, D23 and D60 (superseded for the fee notes).

## Risks

- **A new path that inserts offer lines without the snapshot would read LEGACY.** That is safe (an estimate, never
  verified) but less informative. Every insert today goes through `buildOffers`.
- **The trigger blocks any future code that rewrites a quoted fee.** That is intended. A legitimate re-quote builds a
  new offer, as today.

## Owner decisions

- **Open:** whether a partner-stated fee should need an acknowledgement before publication (D100 recommends it;
  `feeNeedsReview` is the one place to change; gap 135).
- **Open:** the Arabic wording (gap 138).
- **Open:** whether an emirate-wide verified fee may read VERIFIED on a free-zone request (gap 140).
- **For the lawyer:** the PDF's assumption sentence on government fees changed. It now says only a VERIFIED fee was
  checked, where it used to say fees were "as published on the offer date".

## Rollback

Revert the merge. Migration 023 only adds nullable columns and a trigger. If a rollback is needed after offers have
been priced, the columns can stay: the old code ignores them, and the trigger guards only those columns and
`gov_unit_fils`, which the old code also never updates after insert.
