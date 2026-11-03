# E7D Reporting and advisory experiences: the assessment report and the consultation workflow

Status: in-progress (branch `outcome/E7D-reports`, built on E7C; released by the owner on 3 Nov 2026 with the E7
contract, phase 4 "Customer trust and professional reporting")

## Business result

A founder can keep and send what the page told them: a UAE Entity Assessment Report, branded Tasees by MKW Advisors,
with a reference and date, their profile, the structures and jurisdictions compared, every statement and figure
labelled by its evidence, the costs that are checked, the risks and approvals, the unresolved questions, the
recommendation subject to review, the official sources, and whether a person has reviewed it. A client gets the
reviewed version of the same report once a named person at MKW Advisors has approved the advice. An adviser books
the call a lead asked for from the lead's page, and the booking lands in the queue as a task when due.

## Scope

1. **The report** (`packages/core/src/report.ts`, pure): two kinds from real application data. Preliminary, from
   the public view (D80: approved statements and figures only, the rest "to be verified"), with "PRELIMINARY, not
   reviewed by a person, not advice" on it; reviewed, from the advice a named person approved for the client, with
   the reviewer's name and date and every confidence label. Sections: profile, structures compared, jurisdictions
   compared (status, setup and renewal figures where checked, facilities, official source, conditions), rejected
   or uncertain alternatives, licences and obligations, cross-border risks marked for a specialist, unresolved
   questions (data missing, answers to check), recommendation subject to review, approved general guidance
   (preliminary), next steps. No partner cost, margin or payout can appear: the inputs do not carry them and a
   test walks the output.
2. **Download**: the PDF is written by the repository's own text PDF writer (D26: no dependency). Public:
   `GET /api/public/assessments/:code/report.pdf` on a saved result (the page saves first when needed), rate-limited,
   writes nothing (a download is not a return visit; the recovery count the lead score reads stays). Client: `GET /api/client/requests/:id/report.pdf`, the reviewed report once
   the advice is approved, otherwise a preliminary one from the answers only with "pending review" on it; only the
   client's own requests (row-level security).
3. **Print**: the page's print view stays; the report button downloads the PDF and counts as the funnel's printed
   stage.
4. **Consultation booking**: `POST /api/ops/pipeline/leads/:id/consultation` with the date and time and a note
   records the booking on the lead (who booked, when, for when), moves the lead to consultation, adds a follow-up
   due at that time (so it reaches the queue) and audits it. No calendar provider; the adviser writes the time, in
   Gulf Standard Time (the page sends +04:00; the note says GST). A rebooking closes the earlier follow-up.

## Exclusions

- Arabic PDFs (the writer is Latin-only, O15); images, fonts and layout beyond monospaced text (D26).
- Emailing the report (rule 6; the founder downloads it).
- Any new statement: the report says exactly what the page says.

## Acceptance evidence

- Core: the preliminary report never carries an unapproved text or figure (built over the public matrix with no
  approvals: no rule text, no AED figure); the reviewed report carries every confidence label; both carry the
  sections the contract lists; no money word; lines wrap within the PDF's width.
- API: the public report returns a PDF for a saved code (and 404 for an unknown or anonymised one), rate-limited,
  with the preliminary label and no partner, cost or margin field; the client report is the client's own only,
  preliminary until approval and reviewed after, naming the reviewer; booking is ops and founder only, audited,
  creates the follow-up and removes the call request from the queue.
- Smoke: the report downloads from the selector and from the client's advice page; the booking from the lead page;
  axe clean on the changed screens.

## Dependencies and risks

- Depends on E7A–E7C (E7C open; this branch is built on it).
- Risk: the text PDF is plain; the owner may want a designed document later (D26 records the writer).

## Owner decisions

- The report wording and the disclaimer lines (defaults, labelled).
- The reviewed report names the reviewer to the client (today: yes, as the advice page's "Reviewed by" date does
  not; the client may forward the document, so confirm staff names may appear on it).
- Whether the adviser's review status should also name the reviewer to the public (today: never; only the client).

## Rollback

- Revert the pull request. Migration 022 adds nullable columns on leads.
