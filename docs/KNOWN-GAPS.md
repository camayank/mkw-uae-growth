# Known gaps

What this starter does not do yet, most important first. "Built" below means working, tested and exercised
in a browser; everything listed here is not.

## Before the first real client

1. **Email account.** The SES transport, the eleven English templates, the delivery log and the in-app bell
   are built (O2); real delivery waits for the SES account, the SPF/DKIM/DMARC records on mkwadvisors.com and
   the two verified sender addresses. Until `EMAIL=ses`, messages are recorded and printed, not emailed.
2. **Payment provider account.** Payment links, the signed webhook contract (HMAC over timestamp and raw body,
   five-minute window, amount must match) and the client "pay by card" flow exist (O3) behind the `memory`
   provider, whose links lead to a page that says card payments are not live yet. The adapter for the chosen
   provider (Network International, Telr, Checkout.com or Stripe UAE) is written once the merchant account
   exists; their signature scheme replaces the generic one in `lib/payments.ts`.
3. **Invoices wait for MKW's TRN and the tax adviser.** Tax invoices and credit notes are issued, numbered
   gap-free and rendered as PDFs (O3), but they are held as `pending_trn` until the founder enters the TRN on
   the Settings page. Government fees are shown as disbursements with no VAT; that treatment is UNCERTAIN until
   the tax adviser confirms it (checkbox on the Settings page). Partial refunds, invoice re-issue and
   e-invoicing are not built; the invoice PDF is plain text (Courier) and Latin script only until O9.
3b. **Invoice PDF is Latin-script only.** Client legal names in Arabic render as "?" until O9 replaces the
   text writer with one that embeds a font; the FTA requires the recipient's name on a tax invoice.
3a. **Bank bulk-transfer format.** The payout run exports a generic CSV (beneficiary, IBAN, bank, amount,
   reference). Replace the columns with the bank's own template when the sample file arrives.
4. **Verified fee and rule data.** The 83-service catalogue, the government fee table (source, verifier, date,
   90-day staleness) and the rules admin exist (O4). The data in them is still a working estimate: market mids
   are the Sheet's Oct 2026 mid-points, the fee table starts empty (partners' stated fees are used and every
   such line says so), and the five new margin categories carry default rules marked "default, confirm". A
   named qualified person must enter and verify fees before real clients are quoted; pricing stops any line on
   an UNCERTAIN or stale fee for ops.
5. **Partner onboarding beyond creation.** The People page creates a partner firm and its first admin, and the
   Partners page pauses, resumes and edits profile fields, but the licence and agreement checks are still boxes
   ops ticks by hand; the onboarding flow with documents and licence expiry watch is O6.
6. **Object storage in a real bucket.** The S3 adapter is tested against AWS's published signature vectors and a
   loopback fake bucket; it has not yet touched a real bucket in a UAE region. Do that in staging, with one
   upload and one download of a real evidence file, before the first client file.
6a. **Staging deployment.** The compiled build, image and CI exist; nothing is deployed because no cloud account
   exists yet. The container image build is exercised only by CI (`image` job), not yet by a run of that job.

## O10: go-live data and staging

18. **Nothing is deployed.** No cloud account, domain or DNS has been provided, so staging exists only as code
    (`infra/`, checked with `cdk synth`) and a runbook (`docs/DEPLOY.md`). The first deployment will be the first time
    the stacks meet AWS; follow the runbook step by step and expect to fix details (quotas, certificate, DNS).
19. **The real data is not loaded anywhere.** The importers ran as dry runs against a local database
    (`docs/evidence/O10/`). On staging they run only after the owner has seen the staging dry-run report.
20. **Owner decisions and company details are blank.** Every decision keeps its built default and stays UNCERTAIN; no
    fee verifier is named, so all 29 government-fee rows stay unloaded (none has a fee yet) and any fee loaded later
    stays UNCERTAIN until the named verifier signs it. MKW's legal name, licence, address and TRN are blank, so tax
    invoices stay held. Licence number, licensing authority, corporate tax TRN and signatory have no field on the
    platform yet (only legal name, VAT TRN, address and bank name do).
21. **Legal texts are drafts.** Both texts show "Draft, pending legal review" until the lawyer's review is recorded.
    They are English only: an Arabic-speaking client sees the English terms.
22. **No rate cards from the roster.** The workbook's two rate-card rows are drafts without fees. Partners' prices
    arrive through the Sheet export (`pnpm import:sheet`) or the portal once firms are recruited.
23. **FTA tax agents unconfirmed.** 30 of the 60 firms say "Likely" on the FTA register; none is marked a tax agent
    until a person checks the register and ticks it in the console, so tax-agency codes cannot be allocated to them.
24. **Fairness cap, deposit and quality bar are code constants.** An owner answer other than "Agree" needs a code
    change; the import reports it rather than applying it.
25. **Static storage key on staging.** The files bucket is reached with a put-and-get IAM key from Secrets Manager
    (D49); rotate it yearly until the storage adapter reads the task role's credentials.
26. **Imports run from the command line** (a one-off ECS task on staging); there is no upload screen for them.

## O11: ops command centre and event outbox

27. **The document checker reads file names, not files.** Until an AI key and spend cap are supplied (O16), the
    in-memory model checks the name, the declared type, reference and expiry against what the step asked for. It catches
    a wrong or unusual file, a missing licence number and an expiry that has passed or is close; it cannot see a blurred
    scan or a passport that belongs to someone else. Every check says so.
28. **Queue targets and weights are defaults** (D55): MKW has not set them. Change them in `packages/core/src/triage.ts`
    after a few weeks of queue timings.
29. **Queue timings err low** (D56): work started outside the queue (from a client page or an email link) is not timed,
    and resolution is noticed within 15 minutes rather than to the second.
30. **Agent work that keeps failing is only visible in the outbox table.** A message that fails reaches the ops queue;
    a document check that fails five times leaves no draft and no queue item (by design, D54). A screen for it comes with
    O13's job metrics and alerts.
31. **One-click actions cover only what the card shows in full.** Pricing an offer, resolving a dispute, allocating a
    line, reviewing an application, deciding a credit, approving scoping advice or a scope draft, confirming an
    obligation date and releasing a payout open their own page (D55).
32. **A birth date in a file name reaches the model** (D54): dates are kept because expiry and issue dates are what the
    check needs. Nothing leaves the platform until a real model is connected (O16).

## O12: client experience

33. **Wording is a draft for the owner.** The proposal, the intake questions, the next-action sentences and their Arabic
    drafts wait for the owner's wording review (and the Arabic reviewer). The guarantee paragraph in particular states
    the rate as a promise and says what may not qualify; the owner and the lawyer should confirm it matches the client
    terms. Server sentences with a name, date or amount are translated by patterns in `i18n-ar.js`; a sentence the
    patterns miss shows in English and appears on the reviewer's list of untranslated strings.
34. **The same document can be asked for several steps.** The checklist groups requests by step and the next action
    names each kind once, but a passport copy asked for three steps is still three uploads.
35. **Partner and staff screens are unchanged** apart from the module split; their journeys are later work.
36. **The working-day estimate on the proposal is the longest one-off line's milestone plan**, not a promise. Lines
    run in parallel in the estimate; if one step truly waits on another, the real time is longer.

## O13: observability and hardening

37. **No alert address yet.** Until the owner sets `ALERT_EMAIL` (and the staging `alarmEmail`), alerts are logged and
    shown on the System page and in the ops queue only. Staging also runs `EMAIL=console` until SES is verified, so
    there the app's alert emails are printed, not sent (the CloudWatch alarms still email). Nobody is paged out of hours.
38. **A key left "running" waits 24 hours.** If the process stops between a change committing and its answer being
    recorded, repeats with that key get 409 until the key expires (D66). Rare, and safe: the person checks the screen.
39. **Logs stay in the host's log store.** No metrics service, dashboards or tracing; the job durations are in
    `job_runs` and on the System page. CloudWatch Logs Insights can query the JSON lines in staging.
40. **The contract describes requests, not responses.** Bodies, queries and path parameters are generated from the
    schemas; responses are "200 Success" plus the error shape. Typed responses would need a schema per route.
41. **The nightly audit check walks the whole chain.** 1,600 events take a few milliseconds; at millions it should
    check from the last verified event (a checkpoint) and walk the whole chain weekly.
42. **Allocation decisions queue behind one lock** (D68). Fine at tens of decisions a second (the load test runs 50
    engagements a second); a much larger network would lock per partner instead.

## E1: entity correctness (programme: docs/ENTITY-PROGRAMME.md)

46. **Every scoping rule and place is UNCERTAIN.** The engine's statuses are honest about it: nothing is
    `ELIGIBLE_VERIFIED` until a named, qualified person verifies the rules and place data with sources.
47. **Activity permission per place is always "to confirm".** It needs each authority's activity list (E2). Until
    then no place is verified for an exact activity.
48. **One activity and one entity per assessment.** Several independently regulated activities, and holding plus
    operating structures, are not modelled yet (E2, E3).
49. **Seven emirates are not all covered.** There are no places for Umm Al Quwain or Fujairah; there are no coordinates
    and no renewal costs (E2).
50. **Facilities are not on record for any place yet.** Manufacturing therefore shows `DATA_UNAVAILABLE` on every
    place until the catalogue holds facilities (E2).
51. **The public selector, leads and handoff are later phases** (E3–E5). The public assessment needs the owner's
    decision on rule 5 (programme section 3).
52. **The fallback when the preferred structure is excluded is a fixed order** (free zone, mainland, DIFC/ADGM,
    offshore), applied among structures of equal status. While every rule is UNCERTAIN, the statuses rarely tell
    structures apart, so the order decides: for example, an offshore holding with mainland customers falls back to a
    free zone, not the mainland. Ops sees every structure's findings and can approve another. A fact-weighted
    fallback needs verified rules (E2).
53. **The scorecard is not comparable across the E1 change.** Scorecard figures computed before E1 counted repeat
    submissions and repeat disputes; figures after E1 count each step once (D74).

## E2: jurisdiction catalogue and evidence

54. **No authoritative data yet.** The catalogue's machinery is in place, but every seeded figure is still a starting
    estimate (UNCERTAIN), and no authority's activity list, package, relationship or coordinates is recorded. Each
    needs the owner's verifier, through the console or `import catalogue`.
55. **Umm Al Quwain and Fujairah places are not offered.** They have no figures, so they stay inactive. Each can be
    activated once its cost, visas and timeline are recorded.
56. **Activity groups, not exact activities.** An activity list records the 13 activity groups a place confirms. Exact
    licensing activities, at ISIC level, need each authority's list in a machine-readable form.
57. **Pre-E2 verifications are re-dated.** A rule or place verified before E2 has no recorded re-verification date.
    It is treated as due 180 days after its verification date.
58. **No map.** Coordinates are stored with their source; the map view belongs to the public selector (E3).
59. **Rules of thumb recorded before E2 never go stale.** A rule or place marked rule of thumb before E2 has no
    verification date, so no re-verification date can be derived. It stays a rule of thumb until it is recorded again.
60. **A verifier's name is kept.** `verified_by` and `approved_by` are personal data in append-only evidence and
    audit tables, kept as the legal-basis record of who checked what; they are not erased on request.
61. **Any new fact blocks approval of every pending advice** until it is recomputed, because the data digest covers
    every active place and rule. A bulk import therefore forces one recompute per pending request. Hashing only the
    places an advice considered would narrow this.
62. **Abu Dhabi's registrar may be out of date.** Company registration in Abu Dhabi moved to the Abu Dhabi
    Registration Authority (ADRA) in 2023; the seed names the Department of Economic Development. For the owner's
    verifier to confirm and record as a fact.

## E3: public selector

63. **Nothing is approved for public display yet.** Until the owner's verifier verifies rules and places and the
    founder approves them, the public selector shows every statement and figure as "to be verified". Honest, but
    thin.
64. **No map.** Coordinates are on record (E2) but not drawn: a map needs a tile provider, which is an external
    service (rules 7 and 11) and an owner decision.
65. **One session per page load.** The public selector keeps answers in memory only; closing the page loses them.
    Sessions, recovery, separate consents, attribution and scoring are E4.
66. **The disclaimer is a default** (D80), for the owner and a lawyer to settle.

## E4: lead intelligence

67. **The marketing and partner-disclosure consent texts are defaults** (`CONSENT_TEXTS`), labelled UNCERTAIN on
    Settings, for the owner and a lawyer to settle. A new text is a new version.
68. **Retention of leads and saved assessments is not applied until the founder confirms the periods.** The job
    counts what it would anonymise and changes nothing; the default is 365 days.
69. **No booking integration.** A call request is a queue item a person books by hand; a calendar provider is an
    external service and an owner decision.
70. **Lead scores are heuristics**, tuned by reasoning, not by data. They order attention and decide nothing; they
    should be reviewed against real conversions after the pilot.
71. **Partner disclosure consent is recorded but not yet enforced in the partner views**: partners already see a
    request without the client's name until an offer is accepted; naming a client earlier, with this consent, is
    not built.

## E5: handoff and renewals

72. **Only the trade licence renewal is a product.** Visa renewals, establishment-card and office renewals are not
    offered from the calendar yet; a renewal request carries the renewal line only, and ops adds lines at scoping.
73. **A held enquiry is converted by ops, never by the client.** A signed-in client whose public enquiry was held
    starts the request themselves from the New request page (from a saved code, or afresh).
74. **The renewal's emirate is taken from the original engagement**, or the client's latest request; a client with
    companies in two emirates should check it at scoping.

## E6: verification and pilot readiness

75. **One activity per assessment.** A business with several independently regulated activities (scenario 17) is
    assessed on the one it names; the rest reaches a person through the description and the AI draft queue, and no
    quote is published until ops settles it. Several activities per assessment need the authorities' activity lists (E2).
76. **One entity per assessment.** Holding-plus-operating structures (scenario 18) are not modelled; the engine
    assesses one entity, verifies nothing, and a person decides. Multi-entity architecture is a later outcome.
77. **No renewal comparison for an existing licence.** Renewal estimates per place carry their own confidence
    (scenario 14), but comparing a client's current licence against alternatives is not a product; a client who wants
    that asks for a review.
78. **Facilities are not on record for any seeded place.** Manufacturing and storage needs (scenarios 6 and 8)
    return "data missing" everywhere until the founder records each place's facilities as facts (E2); the engine never
    passes or excludes a place on a guess.
79. **The public "no option fits" conclusion waits for the budget rule's approval.** By design (D80): until a named
    person approves `place.budget` for public display, a founder whose budget no option meets sees no recommendation
    and no figure, not the conclusion. Recorded so it is not read as a defect.
80. **Staging checks were not run.** No cloud account exists (gap 6a); `docs/evidence/E6/VERIFICATION.md` lists each
    blocked check and what unblocks it. The container image build is verified by CI only.

## U1: client and partner workspace redesign

81. **Partner screens are English only**, including the redesigned work and engagement pages; the Arabic partner
    wording on the design canvas was not shipped and needs a native reviewer first (O15).
82. **The "In short" summary is a reading of the advice, not a new judgement.** It takes the recommended structure, the
    first-ranked place, the first reason and up to two findings to confirm. A case whose most important point is the
    third finding reads less sharply; the full reasoning is always one panel below.
83. **The offer switch shows what ops built.** If ops build three tiers the client sees three; the design's "one
    offer with another option" is the two-tier case. Whether to stop building the essential tier is a product decision.
84. **The partner's offer row does not show the client's document status before acceptance**, because the allocation
    brief does not carry it; the row says so. Adding it means widening the brief, a later change.
85. **The priority tier's speed does not reach the client.** Tier selection picks the quote with the fewest working
    days, but offer lines do not store them: the proposal's estimate and the engagement's milestone dates come from the
    scope templates, the same for every tier. The screen therefore calls the tier "Priority" and promises no pace
    (raised in the U1 review). Carrying the quoted working days into offer lines, the proposal and the delivery plan is
    an API and schema change for a later outcome.
86. ~~**The browser tab title says "Tasees" for partners.**~~ Closed by E9: the suffix follows the audience (D91). `document.title` follows the heading with " · Tasees" for
    every signed-in role (`js/core.js`), so a partner's tab carries the client brand; the page itself is branded MKW
    Advisors Partner Network. Pre-dates U1; noted in its review. Fix: pick the suffix by audience.
87. **Arabic entries missing for some E5 and E6 client strings.** The gap list the Arabic reviewer sees, read by the
    smoke test after the client screens are visited in Arabic, carries "This offer is accepted.", "On the licence",
    "Renewal requested", "Already answered on our public page?", "Saved result code", "Start from my saved result" and
    the intake placeholders, beside service names, amounts and file names that are left as they are by design. U1's
    own strings are checked not to be in it; the older ones wait for the dictionary round with the reviewer (O15).

## E7A: public product UX

88. **Guidance notes are drafts until the founder approves them**, so a fresh demo and the pilot start with no
    general guidance on the public page; the result says notes appear once a named person approves the wording.
    The notes are listed on the Scoping page with their text.
89. **The homepage and the "why we ask" lines are a draft of the owner's marketing voice**, English first; the
    Arabic entries are drafts under the reviewer gate (gap 1). The smoke test checks the Arabic homepage heading only.
90. **The comparison can only show what the catalogue holds.** Facilities, renewal figures, activity lists and
    authority names are "not on record" or "to be verified" for every seeded place until E7B records them; the
    three-year estimate needs both setup and renewal figures approved.
91. **No funnel events are recorded on the public page** (visitor, assessment started, result viewed, compared,
    saved): E7C, with the consent wording the owner settles.

## E7B: jurisdiction data operations

92. **The catalogue holds no verified data yet, and the first wave is a backlog.** Every one of the fifteen first-wave
    places has twelve evidence tasks open; two (KEZAD, JAFZA) are placeholders by name. The Coverage page and the
    backlog CSV say exactly what to obtain; the named verifier fills it in through the importer. Nothing was looked
    up here: the container has no internet access, and nothing is invented.
93. **Exact licence activities are recorded, not matched.** `activity_codes` are shown for the verifier and on the
    place; the engine confirms the activity group only (D86). Matching a founder's description to an authority's
    code list, and several activities per assessment, need the lists in machine-readable form (gap 75).
94. **Sub-zones are counted under their parent by kind only.** The parent relationship is an authority fact; the
    coverage matrix does not yet draw the tree (authority, operating location, sub-zone) as a hierarchy. JAFZA's
    free zone authority and its offshore registry are two authorities until the verifier records the parent fact.
    Facts recorded before E7B carry `source_kind = official` by the migration's default; the verifier restates the
    source kind when re-verifying them (and the legacy verify-zone endpoint assumes official unless told otherwise).
95. **Legal forms within one jurisdiction never decide eligibility.** They are on record for the verifier; a test
    keeps the engine from guessing with them.

## E7D: reporting and advisory experiences

101. **The report is plain text in a PDF**: the in-house writer draws monospaced Latin text only, so no logo, no
     table rules and no Arabic (O15). The content is complete; the design is an owner choice (D88).
102. **The reviewer's name appears only on the client's report**, never on the public one, which names no person.
103. **A booked call is a record and a queued follow-up**, not a calendar invitation; the adviser sends the invitation
     outside the platform and writes the time here.

## E7C: lead conversion intelligence

96. **Funnel figures start at zero on the pilot's first day** and only count what the public page sends; a visitor
    whose browser blocks session storage or scripts is not counted. Nothing is estimated to fill the gap. The rate
    limit on the events endpoint is per IP (300 batches per quarter hour), so a large office behind one address can
    lose events silently; the page never retries.
97. **"Qualified" is a definition, not a judgement**: high readiness (60 or more), or a person moved the lead to
    consultation or converted, or contacted with a request open (`QUALIFIED` in `services/leads.ts`). The pilot's
    conversions should decide whether the threshold is right; the scores themselves stay heuristics (gap 70).
98. **Lost reasons are free text** typed by the adviser when closing a lead, so the "lost, by reason" table groups by
    exact wording; a fixed list is an owner decision.
99. **Turnaround to first contact depends on the adviser recording the status**; a call that is not recorded as
    "contacted" is not measured.
100. **The measurement notice wording is a default** for the owner and a lawyer to settle, like the consent texts.

## E7E: commercial pilot readiness

104. **The pilot journeys run on the in-memory adapters and the seeded, unverified catalogue**, never on staging: a
     real mailbox, bank, storage region and verified figures are the owner's inputs (gap 80, `docs/evidence/E7E/
     STAGING-CHECKLIST.md` section 2). The go/no-go record says so on every platform row.
105. **The human rows of the go/no-go record are blank**: lawyer, tax adviser, outside security reviewer, fee and
     rule verifiers, public-display approvals, three signed partner firms, five consenting clients. A blank row is a
     no-go for that row.
106. **The journeys' names A to F are the build's reading of the contract** (six people, six paths); the owner
     confirms or renames them (D89).

## E8: quick match

107. **The emirate flags are simplified drawings** (proportions and the Umm Al Quwain crescent are approximate) and
     the map is a schematic. Check the flags against official artwork, or replace them with approved files, before
     the page goes public (D90).
108. **The quick match's counts move only on approved exclusions**, so with few rules approved for public display
     they barely change as the founder answers. Approving the place and budget rules (Scoping, public display) is
     what makes them move; nothing is estimated in between.
109. **The budget bands are defaults** (15,000, 25,000, 50,000, more): an owner decision, changed in
     `QUICK_BUDGETS`.
110. ~~**The canvas restyle is built for the selector only.**~~ Closed by E9, E10 and E11: the client, staff, partner
     and homepage screens are in the new look (D91 to D93).
112. ~~**The order of places uses the engine's statuses and estimates, approved or not.**~~ Closed by E13 (D95, the
     owner's decision of 3 Nov 2026): every public screen orders places on approved facts and the founder's answers
     only, and the quick match names a place to review first only when a person approved it. Staff keep the engine's
     order.
111. **The new Arabic strings are drafts** until the Arabic reviewer signs them off, like the rest of the dictionary.

## E13: recommendation trust

118. **With nothing approved, the public order is the founder's answers, then the name.** So the first places listed
     can be ones a person would rule out at once (a financial centre for a software business, say), because the rule
     that rules them out is not approved for public display yet. The page says so ("listed by your answers, then by
     name") and names no lead. Approving the structure and place rules and the first-wave places (gap 92) is what
     gives the public order meaning; nothing is estimated in between.
119. **The new Arabic strings for E13 are drafts** until the Arabic reviewer signs them off (with gaps 111 and 116).
120. **A review request sent from a quick match without a lead names no place.** It carries the emirate the founder
     chose or, for "anywhere", the emirate of the first place listed (first by name while nothing is approved), so the
     reviewer confirms the emirate before pricing. With a lead, the approved place is sent as the place they have in
     mind, as in E8.
121. **A quick match runs the engine about six times per answer** (the counts per budget band, the full public
     assessment and the structure on the rules alone). Each run is linear in places and rules; at the first wave's
     size this is milliseconds. Reusing one run across them is an optimisation for a larger catalogue.

## E14: front door

122. **The domain is not chosen.** The homepage is at `/` and the workspace at `/app/` on whatever address `APP_URL`
     names; the domain, DNS and certificate wait on the owner (gap 18). Until `APP_URL` is set the canonical links
     are relative and there is no sitemap.
123. **One address serves both languages.** The Arabic homepage is `/?lang=ar` with the same canonical link as the
     English page; separate Arabic addresses with `hreflang` links come with the Arabic sign-off (gaps 111, 119).
124. **The privacy consent text recorded for the homepage still says "selector.html"** (`2026-11-selector-v1`). It is
     the wording a founder agreed to, kept as recorded; a new consent version would name the new address.

## E9: workspace look

113. ~~**The staff console's sidebar from the canvas is not built.**~~ Decided by the owner on 3 Nov 2026: staff keep
     the grouped one-row menu (O10), on the dark bar (D91).
114. ~~**The partner screens get the shared look only.**~~ Closed by E10 (D92): the dark MKW Advisors bar, the
     scorecard on the dark panel, payouts by state, flags and the steps progress, from the platform's own figures.
117. **The canvas's partner on-time streak (the last twelve steps) is not built.** The platform holds the steps and
     their dates, so it could be computed; it is not on screen until the owner wants it (E10).
115. **The journey tracker reads one piece of work**: the newest live engagement, else the newest open request. A
     client with several at once sees the others in their cards below it, not in the tracker.
116. **The new Arabic labels for the journey are drafts** until the Arabic reviewer signs them off (with gap 111).

## O7: launch-gate preparation

43. ~~zod 3 has a memory-exhaustion advisory.~~ Closed by S1: zod 4.6.7 (D71); the body caps stay as defence in depth.
44. ~~Development tools carry advisories (vitest, vite, tinypool, esbuild through tsx, playwright).~~ Closed by E7E
    (D89): all upgraded to patched, pinned versions; `pnpm audit` clean for everything.
45. **Uploads are not scanned.** Files are checked by extension and size, stored privately and only ever downloaded
    as attachments, but nothing inspects their content. Add a malware scan (for example the storage provider's) before
    clients upload at scale.

## Soon after

7. **Scoping rules and zone data are working estimates.** The advice engine, rule confidence, zone table,
   ops approval, AI draft queue and public intake exist (O5). Every rule and zone starts UNCERTAIN and the
   advice says so to the client until the founder records a named person's verification with a source. The
   AI model is the deterministic in-memory double until an API key and spend cap exist; the Claude adapter is
   written against the same interface. The pack's lead page (`03-lead-page`) should post to
   `/api/public/intake` as `intake.html` does; WhatsApp capture waits for the Business number.
8. **E-signature.** The Partner Network Agreement is accepted online per version (O10) and uploaded signed and
   verified by MKW (O6); e-signature waits for the provider.
9. **Guarantee settlement after the balance is paid.** When the balance was already paid, an approved credit
   is `approved` for finance to refund by card or transfer and record the reference; a partial card refund
   through the provider waits for the provider.
10. **Arabic beyond the client screens.** Client screens, the public intake page and client emails are
    translated (O9) and gated on the reviewer's sign-off. Service names from the catalogue, dates and the
    invoice and offer PDFs stay English (an Arabic-capable PDF font and `deliverables.name_ar` are the next
    step); partner and staff screens are English by design.
13. **Accounting system mapping.** Exports use a generic column layout; the Zoho Books / Xero / QuickBooks
    import mapping waits for the owner to name the system. Obligation rules (visa term, VAT periods, CT
    year end, ESR scope) are working assumptions marked UNCERTAIN until ops confirms each date.
11. **WhatsApp notifications** (via the WhatsApp Business API) alongside email. The notifier records a
    `whatsapp` channel as `skipped` today.
12. **Accounting export** of payments, payouts and VAT to the accounting system.
13. **Shared rate limiting.** Sign-in limits are per process; use the proxy or a shared store with more than
    one instance.
14. **Erasure residue.** A PDPL erasure tombstones the person's name, email and messages and ends their access,
    but free text they typed into fields without an author column stays (milestone dispute reasons, allocation
    decline reasons, change-order descriptions, evidence file names), and audit payloads keep what was recorded
    at the time (a name in `partner.created`, a reason in a decline). Backups taken before the erasure keep the
    pre-erasure copy until they age out (35 days locally; the bucket's lifecycle rule in the cloud). Decide with
    the lawyer whether those fields need tombstoning too; if so, add author columns first.
15. **Automatic deletion at the end of a retention period.** Periods are recorded and confirmable on the
    Settings page; nothing is deleted on their basis yet. Needs confirmed periods and a rule for what counts as
    the start of each period.
16. **Template wording approval.** The English wording in `templates.ts` needs the owner's sign-off before
    launch; Arabic versions are O9.
17b. **`deliverables.active` is not editable yet.** The column exists and inactive codes are hidden, but no
    screen switches a code off; do it by SQL until the catalogue screen gets the control.
17a. **UAE public holidays are expected dates.** The calendar is a setting with a founder screen (O10); the import
    loads the 14 dates from the go-live workbook (2 Dec 2026 to 3 Dec 2027), every one "expected". The founder confirms
    each when the government announces it, and adds the next year's dates before December 2027.
17. ~~Row-level security tests run on PGlite in CI.~~ Closed in O13: a CI job runs the whole API suite, the race tests
    and a small load test on PostgreSQL 16 on every pull request.

## Verified so far

- E6: the 26 contract scenarios end to end over HTTP on the seeded (unverified) catalogue, each asserting the
  checks that apply (status, exclusion or escalation, reasons, confidence, no invented price, no unauthorised
  reading, no irreversible action, screens agree with the API); the full suites on PGlite and PostgreSQL 16; the
  browser smoke test with the selector, mobile and axe; the load test; the audit chain of the smoke run; the
  infrastructure synth. Executed, CI-only and blocked checks are separated in `docs/evidence/E6/VERIFICATION.md`;
  the traceability table is `docs/evidence/E6/SCENARIOS.md`.
- O13: 57 domain tests and the API suite, all passing on PGlite and on PostgreSQL 16, including a brand-new server
  (CI runs both); the race tests fail without the locks they prove; a 200-engagement load test holds every invariant
  (`docs/evidence/O13/`).
- 57 domain tests (`packages/core`) and 212 API tests (`apps/api`), all passing on PGlite and on PostgreSQL 16;
  typecheck clean; `pnpm build` compiles and the compiled server runs in production mode from a fresh database.
- O1: partner creation, invitations, role changes and deactivation (sessions revoked, codes refused) are tested as
  every role; PDPL export contains one person's data and no audit payloads (a test reproduces the leak that the
  review found and shows it closed); erasure keeps payments, payouts and every audit row byte-for-byte and the
  recomputed chain verifies; a tampered audit row is detected; the S3 adapter reproduces both AWS SigV4 test
  vectors and round-trips through a loopback fake bucket; the restore drill passed on Postgres 16
  (`docs/RESTORE-DRILL.md`); the browser smoke test drives the new People and Settings screens and now fails
  the run on any of its 13 role-separation and layout checks (`docs/evidence/O1/`).
- O2: every template renders under all three audiences with the right branding; a flow records offer, deposit,
  allocation, change-order and QA notices with sender, audience and provider result; each person's bell holds
  only their rows (database-enforced); a provider failure is recorded and never blocks the action; the digest
  fires once per working morning and not on Friday evening or Saturday; the SES transport is verified against a
  loopback fake that recomputes the signature (`docs/evidence/O2/`, 21 smoke checks).
- O4: 82 codes cover the 83 Service Catalogue rows and every code has a rule and evidence types; fee lookup by
  emirate and zone (zone beats emirate); UNCERTAIN and stale fees send the line to review with the reason and a
  verified one clears it; a scheduled rule applies only from its date, earlier offers keep their figures and
  `rules_as_of`; founder-only writes, database denies rules and fees to clients and partners; ten sample
  requests (30+ lines, new and old codes, agent and reseller) reproduce the margin rule to the fils, and the
  Sheet's OF-0001 totals are reproduced (`docs/evidence/O4/`, 29 smoke checks).
- O3: payment link on acceptance; unsigned, mis-signed, stale, tampered and short-paid webhooks refused and
  audited, a good one idempotent; invoices held without a TRN and issued in sequence after it, lines add up to
  the payment, PDF well-formed and downloadable by the client only; refund → credit note, payouts withheld,
  statement balances; partner invoice must match the payout and only its partner may upload; payout run total
  equals the bank file total, one line per partner, marking paid releases and sends remittances without the
  name Tasees; ops locked out of runs, files and refunds (`docs/evidence/O3/`, 43 smoke checks).
- O5: 20 founder cases give the expected structure, places, licences and obligations, each exactly as confident
  as its rule; advice is held for ops review and the client sees nothing until approval, then sees confidence
  labels; recomputing after a rule is verified puts it back under review; founder-only verification with name
  and source; AI drafts change nothing until approved and never after pricing; public intake refuses without
  consent, swallows bots, records consent with version and timestamp, is rate-limited; search is staff-only
  a repeat email is held for ops rather than attached; the client role cannot read unapproved advice at the
  database; changing the structure at approval ranks places again (`docs/evidence/O5/`, 56 smoke checks).
- O6: onboarding gates (pilot needs a verified unexpired licence; signed needs the agreement and insurance);
  documents and scorecards invisible to other firms and to clients at the API and the database; licence
  warning once at 30 days, pause on expiry, pause lifted by a verified renewal; staff scoped to the firm;
  client document checklist on acceptance, partner extras, received/ask-again with masked notes, files to the
  parties only; delay noticed once with both sides told, ops attribution hidden from the parties; credit by
  rule after five working days at the step's share of the fee, finance-only decision, balance reduced and
  partner-borne delay reduces the completion payout, all audited; rating once by the owner, masked for the
  partner, feeding the scorecard; month share per category; manual allocation refused for ineligible or
  over-cost partners and audited with the engine's own choice; offer PDF names no partner
  (`docs/evidence/O6/`, 68 smoke checks).
- O8: founder figures (revenue, VAT, cash, payouts due, margin, on-time, funnel) reconcile to the database
  rows; ops gets the same without margin; period parsing and previous period; partner dashboard carries no
  client price or other firm; CSV exports match the rows, neutralise formula text, refuse margin to ops, are
  logged and audited; obligations generated pending review and invisible to the client at the API and the
  database, confirmed with a note, waived with a reason, met only with checked evidence, rolled forward,
  reminded at 30 and 7 days and once overdue from Tasees with the "we do not file" line
  (`docs/evidence/O8/`, 79 smoke checks).
- O9: every client-facing template has an Arabic version carrying the same links and references with no
  English placeholders; clients are refused Arabic (409) until the founder records the reviewer, staff may
  preview; Arabic emails go to an Arabic-speaking client after sign-off and partner emails stay English;
  withdrawing the sign-off resets clients to English. Smoke: axe-core zero violations on 15 screens in both
  languages (`docs/evidence/O9/axe.json`), keyboard-only sign-in and navigation, Arabic screenshots
  (`docs/evidence/O9/`, 109 smoke checks).
- O11: a message is written to the outbox in the change's own transaction, is delivered exactly once however many
  dispatchers run, is retried after 1, 5, 15 and 60 minutes and then waits for a person, and is never re-sent on its
  own when its delivery is in doubt (Mark delivered, Send again, Cancel: ops only, audited); sign-in codes never enter
  the outbox; erasure cancels a person's unsent messages and removes their address. The document checker drafts a check
  for every upload from metadata only, and a model failure blocks nothing. The ranked queue puts work past its target
  first (working hours, weekends and holidays), says why each item is there and what raises it, shows each role only its
  buttons, and times items from arrival and from opening. On-time rates use the first submission's Dubai date, which
  removed three date-dependent test failures on `main`. Smoke: the ranked queue with the check beside the partner
  document, a one-click "Check is right", the filter, at 1280 and 390 px, axe-core clean.
- O10: each importer's dry run writes nothing, `--apply` is idempotent with one audit event per record and no
  notification rows, and re-imports keep what MKW changed in the console; hostile workbooks are refused; the five
  real files dry-run cleanly (redacted reports in `docs/evidence/O10/`); `invite_pending` users cannot sign in until
  the pilot move; the terms version is stored on acceptance and stale versions refused; holidays from Settings move
  SLA deadlines; `cdk synth` builds both stacks; concurrent migrations on PostgreSQL 16 apply each file once. Smoke:
  grouped menu, legal and holiday Settings, terms at acceptance and the agreement at 1280 and 390 px, axe-core clean.
- `pricing.test.ts` reproduces the Google Sheet Offer Builder example exactly.
- `security.test.ts` shows Postgres refusing margin and partner-cost columns to clients, client price to partners,
  and other organisations' rows; sign-in throttling; security headers.
- A browser run (Chromium) drove one engagement end to end through the web app as client, ops, finance and three
  partners, with no page errors under the content security policy; the client page showed no partner cost,
  margin, phone number or email, and the mobile layout had no horizontal scroll.
