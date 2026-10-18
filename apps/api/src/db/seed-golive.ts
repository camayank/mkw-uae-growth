import type { Database } from "../lib/db.ts";
import { runImport } from "../import/common.ts";
import { importPartners } from "../import/partners.ts";
import { upsertLegalText } from "../services/legal.ts";

/**
 * Development demo for O10 (never loaded in production, never used by the tests): placeholder legal texts so the
 * acceptance and onboarding screens can be seen, and one synthetic prospect brought in through the real partner
 * importer, so the console shows what an imported firm looks like. No real firm, person or term is in here; the
 * real texts and roster are imported from data/import/, which is never committed.
 */
const DEMO_TERMS = `# Tasees Client Terms

Demo text for development. The real client terms are imported from data/import/ and are not in the repository.

## 1. How an engagement works

1. You tell us what you need and we send a written offer.
2. You accept the offer and pay the first instalment.
3. Each step is complete only when its proof is attached and you approve it, or 5 working days pass.

## 2. Prices

- **Professional fees:** fixed for the scope in the offer.
- **VAT:** 5% on professional fees.
- **Government fees:** charged at cost, with the official receipt.
`;

const DEMO_AGREEMENT = `# MKW Partner Network Agreement

Demo text for development. The real agreement is imported from data/import/ and is not in the repository.

## 1. Parties and purpose

MKW Advisors runs the MKW Advisors Partner Network and offers vetted firms work for its clients.

## 2. Ways of working

- Work is offered with its scope, payout and reply deadline.
- Each step closes on evidence checked by MKW Advisors.
- Payouts are staged and paid from money received.
`;

const HEADER = ["Partner ID", "Firm", "Segment", "Head office emirates", "Service codes (platform)", "Free zones served", "Website", "Business email", "Business phone", "Status", "Capacity (jobs per month)", "FTA tax agent (verify)", "Notes"];

export async function seedGoLiveDemo(db: Database) {
  await runImport(db, null, true, async (tx) => {
    await upsertLegalText(tx, "client_terms", "Tasees Client Terms", DEMO_TERMS, "development seed");
    await upsertLegalText(tx, "partner_agreement", "MKW Partner Network Agreement", DEMO_AGREEMENT, "development seed");
    const book = new Map([
      [
        "Partners",
        [
          HEADER,
          ["GB0000", "Example Prospect Consultants", "Setup + Accounting", "Dubai; Sharjah", "SET-FZ-LIC; VISA-RES; ACC-BOOK; VAT-RET", "IFZA, SHAMS", "example-prospect.test", "info@example-prospect.test", "+971 4 000 0000", "Prospect", "12", "Likely: check the FTA register", "Synthetic demo firm (development seed)"],
        ],
      ],
    ]);
    return importPartners(tx, book, "development seed");
  });
}
