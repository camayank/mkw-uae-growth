# O10 evidence

## Import dry runs of the real go-live data

The five files MKW Advisors supplied (go-live workbook, owner decisions, company details, client terms, partner
agreement) sit in `data/import/`, which git ignores; they are never committed. Each report below is the dry run of
`import all`, redacted by the importer itself (`--evidence`): firm names, email addresses, phone numbers and web
addresses are removed; Partner IDs, row numbers, counts and reasons stay.

```
PGLITE_DIR=<a migrated, catalogue-only development database> \
  pnpm import:dev all "$(pwd)/data/import" --as <founder email> --evidence docs/evidence/O10
```

| Report | Created | Updated | Unchanged | Skipped | Why |
| --- | ---: | ---: | ---: | ---: | --- |
| [partners.md](partners.md) | 60 | 0 | 0 | 0 | every firm a prospect; 30 marked FTA "Likely" stay unticked until a person checks the FTA register |
| [rate-cards.md](rate-cards.md) | 0 | 0 | 0 | 2 | both rows are Draft with no professional fee |
| [fees.md](fees.md) | 0 | 0 | 0 | 29 | no fee filled in yet |
| [holidays.md](holidays.md) | 14 | 0 | 0 | 0 | all "expected" until announced |
| [company.md](company.md) | 0 | 0 | 9 | 3 | every field blank; the three emails are deployment settings |
| [decisions.md](decisions.md) | 0 | 0 | 22 | 0 | no answers yet: today's values stay, UNCERTAIN where they show |
| [legal-client-terms.md](legal-client-terms.md) | 1 | 0 | 0 | 0 | version 1, "Draft, pending legal review" |
| [legal-partner-agreement.md](legal-partner-agreement.md) | 1 | 0 | 0 | 0 | version 1, "Draft, pending legal review" |

The whole run is one transaction that is rolled back, so the reports are exactly what `--apply` would do. Nothing
was applied anywhere: there is no staging database yet, and the owner sees these reports before any `--apply`.

The importer refuses to guess its target or touch the schema (18 Oct 2026):

```
$ pnpm import:dev partners data/import/Tasees-Go-Live-Data.xlsx          # neither variable set
Set DATABASE_URL (staging, production) or PGLITE_DIR (a development database) to say which database to import into.
$ PGLITE_DIR=/no/such/dir pnpm import:dev partners ...
No database at PGLITE_DIR=/no/such/dir. Seed or start the server once first.
$ PGLITE_DIR=<database without the migrations> pnpm import:dev partners ...
The database is missing migrations (001_init.sql, ..., 010_real_data.sql). Start the server once so it migrates,
then import. The importer never changes the schema.
```

## Browser smoke test

`log.txt`: `scripts/smoke.mjs` against a freshly seeded demo, 135 checks OK, no page errors, axe-core WCAG 2.1 AA
clean on 22 screens, the O10 ones at 1280 and 390 px (`axe.json`). Screenshots of the new screens:

| Screen | 1280 px | 390 px |
| --- | --- | --- |
| Staff console menu (Work open; Setup open on the phone) | `61-console-menu.png` | `65-mobile-console-menu.png` |
| Settings: legal texts and public holidays | `62-settings-legal-holidays.png` | `66-mobile-settings-legal.png` |
| A prospect as imported (synthetic demo firm) | `63-ops-imported-prospect.png` | |
| Partner Network Agreement in onboarding | `64-partner-agreement.png` | `67-mobile-partner-agreement.png` |
| Client terms ticked when accepting an offer | `07-client-offer.png` | |
