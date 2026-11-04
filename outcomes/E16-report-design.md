# E16 Report design: the assessment report as a designed PDF, in English or Arabic

Status: merged (camayank/mkw-uae-growth#37, 3 Nov 2026; previously verified-pending-merge, branch `outcome/E16-report-design`, on `main` at 61856ea with E15 merged; released by
the owner on 3 Nov 2026: "start E16". The owner approved the library ("Approve pdfkit") and the scope ("Assessment
report only").)

## Business result

The UAE Entity Assessment Report that a founder downloads, keeps and forwards reads like an adviser's document:

- the brand and the title at the top, and the status as a banner;
- each section titled, with the places compared in a real table;
- every point carrying a coloured label ("checked", "to be verified", "does not fit");
- the official sources, and a footer with the reference and the page.

An Arabic-speaking founder can have it in Arabic, laid out right to left, once Arabic is signed off.

## Scope

1. **Library and fonts.**
   - Libraries: pdfkit 0.20.2 and bidi-js 1.1.0, plus @types/pdfkit 0.17.7 for development, all pinned exactly (D98).
   - Fonts: Noto Sans and Noto Sans Arabic in `apps/api/assets/fonts`, with `OFL.txt`.
   - The Dockerfile copies the fonts into the image.
2. **Core** (`packages/core/src/report.ts`):
   - the report carries a comparison table for the places, an "Official sources" section (a preliminary report lists
     only approved places' sources), its closing line and its language;
   - `reportLines`, the plain-text version, is unchanged in behaviour.
3. **Arabic** (`packages/core/src/report-ar.ts`, pure):
   - `arabicReport` translates the report's own wording: headings, labels, tags, statuses, structures, the profile,
     table columns and cells, the fixed sentences;
   - the engine's statements, guidance, names, addresses and dates stay as written, marked as left-to-right islands;
   - the wording is a draft for the Arabic reviewer.
4. **Renderer** (`apps/api/src/lib/report-pdf.ts`):
   - the header, the banner, sections, tables (with the header repeated on a new page), tags, sources and a footer
     on every page;
   - every line laid out by the bidirectional algorithm.

   It returns the PDF and the text it drew.
5. **Service and routes**: `publicReportPdf` and `clientReportPdf` take a language (`?lang=ar` on both report routes).
   - **Public report:** Arabic only once the Arabic reviewer has signed off.
   - **Client's report:** Arabic when Arabic is available to that client.
   - **Arabic file name:** ends in `-ar.pdf`.
6. **Pages**: the public page and the client's advice page ask for the report in their own language.

## Exclusions

- Invoices, credit notes, offers and remittance advices keep the in-house writer (gap 3b).
- A logo artwork (gap 132).
- Separate Arabic engine wording: the engine's statements stay English (gap 129).

## Acceptance evidence

- Core (`packages/core/test/report-ar.test.ts`, new). Over 386 founders × 4 reports (preliminary with and without
  approvals, reviewed with and without a reviewer):
  - every word the report writes is Arabic;
  - every English island is data (mutation-checked: removing a translation fails the test);
  - every section, line, table row, number, address, place name and tag is still there.

  Plus a worked example: the table's columns and cells, and the sources.
- API (`apps/api/test/report.test.ts`, `pilot-journeys.test.ts`):
  - every report download is a designed PDF, with the Noto fonts embedded;
  - what it says (the drawn text) carries the label, the sections, the sources and the page footer, and no money
    word;
  - the reviewed report names the reviewer.
- API, the Arabic rule:
  - English before the sign-off;
  - Arabic after it, with the Arabic font embedded and the `-ar.pdf` file name;
  - a client's report in Arabic once available to them;
  - a partner gets no report.
- Smoke (`scripts/smoke.mjs`):
  - the preliminary and reviewed reports are designed PDFs of at least two pages, and their words (read with
    pdftotext) carry the label, the sections, the approved figures and no money word;
  - the Arabic report has the Arabic font, the `-ar.pdf` name and the Arabic title;
  - each file and its first pages are kept.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E16/`):

- `pnpm test` (`tests-pglite.txt`): core 154 passed (18 files); API 370 passed, 1 skipped (37 files), on PGlite.
- `pnpm typecheck`: clean (`typecheck.txt`).
- `pnpm audit --prod`: no known vulnerabilities (`audit.txt`).
- `scripts/smoke.mjs` against a fresh demo: 326 checks OK, 0 failed (`smoke-log.txt`; 325 after E15).
- The reports and their first two pages:
  - `120-report-preliminary` (with IFZA approved);
  - `121-report-reviewed`;
  - `122-report-preliminary-ar`.

## Independent review

Nothing blocking. The privacy rule (D80), the money rule and the Arabic sign-off rule hold. The reviewer probed the
table, the sources, the metadata and the language rule.

Fixed:
- **Smoke strictness.** Without pdftotext, the smoke test passed its word checks without reading the words. It now
  fails, unless `SMOKE_NO_PDFTOTEXT=1`, and CI installs poppler.
- **Tall items.** An item or table row taller than a page ran over the footer. Paragraphs now flow line by line
  across pages, and table cells are capped.
- **Licences in D98.** The record said every package was MIT; it now lists each licence as declared.
- **Stray direction marks** in the PDF metadata.
- **An empty table** made the renderer throw.
- **Data with line breaks or direction marks** broke the Arabic profile line or the island balance.
- **Headings** could be stranded at the foot of a page.
- **Amounts** could split across lines.

New renderer tests (`apps/api/test/report-pdf.test.ts`):
- a 2,000-word item flows over six pages with every word drawn;
- empty tables and sections render;
- odd data (line breaks, tabs, direction marks, emoji, Chinese characters, a 500-character cell) renders in both
  languages;
- the metadata carries no direction mark.

Recorded: the Arabic grammar points for the reviewer (gap 129); characters outside the fonts (gap 133).

## Codex review and CI

- **Codex (fixed with a test).** The Arabic table's columns were placed as in the English one: Place on the left. They
  now run from the right edge (`tableLayout`), the exact mirror of the English, as `122-report-preliminary-ar-1.png`
  shows.
- **CI.** The public report's rate-limit test timed out on the runner: it renders up to 30 designed reports before the
  limit answers 429. It now has a 60-second timeout. The limit itself is unchanged.

## Dependencies

E7D (the report), E13 (the public order). New libraries recorded in D98.

## Risks

- **Arabic layout errors in unusual text.** Mitigated:
  - the bidi algorithm is a full implementation;
  - each line is laid out from its levels;
  - the Arabic test covers 386 founders' reports;
  - the pages were checked by eye.

  Copy-paste of Arabic from the PDF can change a joined letter (gap 130).
- **File size.** The fonts are embedded as subsets: a report is about 25 KB in English and 70 KB in Arabic.

## Owner decisions

- Decided: pdfkit and the fonts, the assessment report only (3 Nov 2026).
- Open: the Arabic wording (gap 129) and a logo artwork (gap 132).

## Rollback

Revert the merge. The report goes back to the text writer. Remove pdfkit, bidi-js and the fonts (D98). No migration,
no data.
