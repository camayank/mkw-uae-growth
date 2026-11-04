# E22 Upload quarantine: a file is what it says, and is held until it is scanned

Status: verified-pending-merge (branch `outcome/E22-upload-quarantine`, from `main` at 548fa49 with E21 merged; released by the
owner on 4 Nov 2026: "start E22". The transformation mandate's P0-01, item 1.3, as `docs/transformation/ROADMAP.md`
orders it.)

## Business result

- **Content matches the name.** An uploaded file's bytes are checked against its extension. A PDF must be a PDF, an
  image an image, and a Word or Excel file one. Anything else is refused, with the reason.
- **Held until scanned.** Every uploaded file is held until a malware scan finds it clean. Nobody can download it
  until then: not the client, not the partner, not MKW.
- **Nobody acts on a held file.** No person can mark a document received, verify a partner document, pass a step's
  QA or mark an obligation met on it.
- **A failed or missing scan never counts as clean.** No scanner, a scanner that errors and a scanner that finds
  malware each leave the file held, and say so on screen.
- **Ops can see what is held and why** on the System page. An infected or unscannable file opens an alert.

## Scope

1. **The content check** (`lib/storage.ts`, `checkUpload`), for every storage adapter:
   - PDF, PNG, JPEG and WebP by their signatures;
   - `doc` and `xls` as OLE compound files;
   - `docx` and `xlsx` as ZIP packages holding `word/` or `xl/`;
   - `csv` and `txt` as UTF-8 text with no binary control bytes.
2. **The scanner adapter** (`lib/scanner.ts`):
   - an interface: scan bytes, answer clean or infected, or throw;
   - `memoryScanner()`, the test double. It finds the industry-standard EICAR test file (the string is built at run time) and can be told to fail. It is labelled on screen as a test scanner, not a malware scan;
   - `scannerFromEnv()`. `SCANNER=memory` is refused in production. When unset, there is no scanner and uploads are held.
   - There is no live scanner. That is T6 (the owner's decision, and its cost).
3. **Quarantine state** (migration 028, `file_scans`). One row per stored upload records:
   - its detected type, size and SHA-256;
   - who uploaded it;
   - its scan status: `pending`, `clean`, `infected`, `failed` or `not_scanned`;
   - the scanner, any finding and the attempts.

   Moves after the upload go through `transition()`, as a seventh machine (`file`), each one audited. Clients and
   partners never read the table. They see only a file's status, through `file_scan_status(kind, id)`. Existing files are
   backfilled as `pending`.
4. **Uploads.** All five upload paths go through one `storeUpload()`, in the same transaction as their row:
   - evidence;
   - client documents;
   - partner documents;
   - obligation evidence;
   - partner invoices.

   It checks the content, scans the bytes (with a time limit), stores the file and records the result.
5. **Downloads.** The four routes that serve an uploaded file refuse anything not `clean` with a 409 that says why.
   `not_scanned` is served only if the owner chooses it under T6 (`UPLOADS_UNSCANNED=allow`), and is then labelled.
6. **Decisions.** Each of these is refused on a held file:
   - QA pass;
   - "document received";
   - "partner document verified";
   - "obligation met";
   - a partner invoice counting as uploaded for a payout.
7. **Replacement.** A refused file must not block the work for good (Codex review): a new evidence file of the same
   kind supersedes earlier ones the scan has not found clean, and a held partner invoice may be replaced by a clean
   one. The held rows stay, quarantined; the replacement is audited (migration 029).
8. **Retry.** A jobs step (`filesScanned`) re-reads and scans files that are `pending`, `failed` (up to five attempts)
   or `not_scanned`, once a scanner is configured.
9. **Screens.** Every file link shows the file's state instead of a link while it is held. The System page shows the
   scanner and the files by status. An alert opens for infected or failed files.

## Exclusions

- **No live scanner** (T6): no ClamAV container and no managed service. Staging keeps uploads held until the owner
  decides.
- **No deletion of infected bytes.** They stay in storage, never served (quarantine). Removal is a later, audited
  decision.
- **Generated files** (MKW's own invoice PDFs and the payout bank file) are not scanned. MKW builds them.

## Acceptance evidence

`docs/evidence/E22/`:

- **`before-fix.txt`.** A probe on `main` at 548fa49: PNG bytes named `.pdf` and a Windows program named `.jpg` were
  both stored, and the client downloaded the EICAR test file at once. The new suite cannot load on `main`.
- **`tests-pglite.txt`.** Core 159 passed (19 files). API 434 passed, 7 skipped (44 files).
- **`tests-postgres16.txt`.** API 441 passed (44 files), on PostgreSQL 16.15, with the runtime-login suite.
- **`typecheck.txt`.** Clean.
- **`smoke-log.txt`.** 337 checks and 60 axe scans passed on a fresh demo, with `SCANNER=memory`: every upload the
  smoke makes is scanned by the test double and served as clean.
- **`screens/79-system.png`, `screens/80-mobile-system.png`.** The System page with the new "Uploaded files" section,
  at 1280 and 390 px.
- **`screens/e22-client-held-*.png`, `e22-staff-held-*.png`, `e22-system-held-*.png` and `held-screens.json`.** A local
  demo with three EICAR uploads (a partner's evidence and two client documents): the client's engagement page shows
  "refused by the malware scan" instead of a link, MKW's view of the same engagement shows the held evidence, and the
  System page shows the "Uploaded files held" alert and the three files, at 1280 and 390 px, each axe-clean with no
  horizontal overflow and no page errors.

The new and changed tests:
- `uploads.test.ts` (12): the content check for each type, and the forms real files take; a clean replacement of a refused
  evidence file and of a refused partner invoice; a clean file served and recorded; an infected file held on
  download, on QA and on the System page, with its alert; the scan table unreadable by clients and partners; with no
  scanner, evidence, a client document and a partner document held on every route and refused as received or
  verified, then released by the jobs step; a failing scanner and its retry; unscanned files allowed by the owner;
- `transitions.test.ts`: the file machine's moves and constraint, with the six others;
- `storage.test.ts`, `queue.test.ts`, `notifications.test.ts`, `payments.test.ts`: fixtures now carry the bytes their
  names claim (a `.txt` holds text, a `.pdf` starts `%PDF-`).

## Business invariants touched

- **Rule 5 (uncertain is a state).** A file nobody scanned is `pending` or `not_scanned`, never clean, and every
  screen says so.
- **Rule 7 (adapters).** The scanner is an adapter with an in-memory double; tests never call the internet.
- **Rule 6 (no unattended side effects).** The jobs step only scans and records; nothing is sent or deleted.
- **Rule 1 (money privacy).** Unchanged: `file_scans` is platform-only, and `file_scan_status` returns a status for a
  row the caller already holds.
- **Rule 9 (PDPL).** Erasure tombstones the file names in `file_scans`.

## Independent review

An independent reviewer read the change against the code and probed it on PGlite and PostgreSQL 16.

- **Should fix, a regression:** the ops compliance page lost its evidence links, because `opsCalendar` had no scan
  column and the screen treats a missing state as held. Fixed, with a test on both calendars.
- **Minor, all fixed with tests:**
  - two sweeps at once made the second abort its step: each file is now re-read under the audit lock, in the
    documented lock order, and a file another sweep moved is skipped;
  - `not_scanned` files were retried forever: every held state stops at five attempts and alerts;
  - real files refused: a PDF with a byte-order mark or junk before its header, and a workbook that embeds a Word
    document; and a `.docx` renamed `.doc` was refused with the same word on both sides;
  - backfilled rows kept no size or hash: the first scan fills them in.
- **Noted, not changed:** `file_scan_status` answers for any id (SQL only; no route passes a caller's id; recorded in
  D104); an object written before a rolled-back row is held and only wastes space (D104); CSV from Excel in a
  Windows code page and UTF-16 text are refused as "another kind" (gap 155).

**Codex, on the pull request,** found two blocking consequences of quarantine: a refused evidence file blocked the
step's QA for good, and a refused partner invoice could never be replaced, so its payout was unpayable. Fixed with
migration 029 (scope item 7) and a test for each.

The reviewer verified as correct: every reader of uploaded bytes is guarded; all five upload paths go through
`storeUpload`; a missing row is held; the machine's moves and cap; the grants, RLS and erasure; the configuration and
the staging stack leaving `SCANNER` unset; every screen's file link; the evidence counts.

## Dependencies

E21 (merged): the machine pattern and `transition()`.

## Risks

- **A real file refused by the content check.**
  - Mitigated: the signatures are the formats' own.
  - A refusal names what the file looks like.
  - The tests cover each type.
- **Uploads held in staging stop the pilot's flows.** This is intended until T6 is decided. The owner can allow
  labelled unscanned files instead.

## Owner decisions

T6, open: a live scanner and its cost, or accept "not scanned" as a labelled state for the pilot.

## Rollback

Revert the merge. Migration 028 only adds a table, a function and a machine. The old code ignores `file_scans`.
