# Architecture — UAE ASP Selector

Version 1.1 (partner mode) · data as of 17 October 2026

## 1. What it is

A neutral, free selector that ranks all 67 Ministry of Finance (MoF) accredited e‑invoicing service providers (ASPs) against a business's ERP, size, licensing zone, entity count, invoice volume and GCC footprint; shows the business's legal dates and penalty exposure; and generates a tailored readiness checklist. It exists to put the publisher upstream of every ASP in a 67‑vendor market and to turn forwarded links into advisory conversations.

## 2. Design decision: no server

The page is a single static HTML file. The "backend" is split in two:

| Where | What runs there | Why |
|---|---|---|
| **Compile time** (this repo) | Research pipeline → normalised provider dataset → regulatory facts → build | Provider data changes weekly at most; a build is cheaper and more auditable than a live API. Every data point keeps its source URL. |
| **Browser** (the page) | Scoring, deadline, penalty, checklist, share‑token, directory and compare engines | Visitors are anonymous SME finance heads arriving from WhatsApp. No login, no cookie banner, no latency, works offline once loaded. |

Consequences: nothing is stored server‑side; leads leave through WhatsApp deep links with the visitor's answers pre‑filled; a share link carries the answers in a URL hash token. A lead‑storage backend is a documented extension (section 9), not a prerequisite.

## 3. System diagram

```mermaid
flowchart LR
  subgraph Sources
    MOF[MoF ASP register<br/>67 providers + accreditation numbers]
    SITES[Each provider's public website]
    LAW[MoF / FTA decisions & guidelines<br/>MD 243, 244/2025 · MD 66, 168/2026 · CD 106/2025]
  end
  subgraph Compile time
    AG[Research agents<br/>4 × 17 providers, fixed JSON schema] --> RAW[data/raw/asp_data_A–D.json]
    LAW --> REG[data/reg_facts.json]
    RAW --> BUILD[build/build.py<br/>validate · normalise · inject]
    BUILD --> PROV[data/providers.json]
    TPL[src/template.html<br/>UI + engines + curated REG] --> BUILD
    BUILD --> ART[dist/asp_selector.artifact.html]
    BUILD --> IDX[dist/index.html]
  end
  subgraph Runtime (browser)
    WIZ[Wizard · 7 questions] --> ENG[Scoring engine]
    ENG --> RES[Ranked shortlist + reasons]
    WIZ --> DL[Deadline + exposure engine]
    WIZ --> CK[Checklist engine]
    DIR[Directory · search · filters · compare]
    TOK[Share token ⇄ URL hash]
    LS[(localStorage<br/>answers · ticks)]
  end
  MOF --> AG
  SITES --> AG
  ART -->|Claude Artifact hosting| V[Visitor]
  IDX -->|any static host / own domain| V
  V -->|wa.me deep link with summary| ADV[Adviser WhatsApp]
  V -->|wa.me share| ACC[Visitor's accountant]
```

## 4. Repository layout

```
asp-selector/
├── README.md                  quick start, runbook
├── docs/
│   ├── ARCHITECTURE.md        this file
│   └── DATA_DICTIONARY.md     every field of a provider record and of reg_facts
├── src/
│   └── template.html          the page: CSS tokens, markup, all engines; DATA injected at build
├── data/
│   ├── providers.json         normalised dataset the page ships (built)
│   ├── reg_facts.json         sourced regulatory facts (phases, instruments, penalties, scope, standard)
│   └── raw/
│       ├── asp_data_A.json    research output, providers 1–17
│       ├── asp_data_B.json    18–34
│       ├── asp_data_C.json    35–51
│       ├── asp_data_D.json    52–67
│       └── asp_all_merged.json  merged raw (pre‑normalisation), for diffing
├── build/
│   └── build.py               the only build step (stdlib Python)
├── dist/
│   ├── asp_selector.artifact.html   fragment published through the Claude Artifact tool
│   └── index.html                   standalone page for any static host
└── tests/
    ├── package.json
    └── test.js                jsdom smoke test (wizard, token, scoring, directory, compare)
```

## 5. Data pipeline

1. **Register** — the MoF page lists every accredited ASP with accreditation number and contact. It is the universe; nothing is added that is not on it.
2. **Research** — four agents each take 17 providers and fill a fixed JSON schema from the provider's own site (homepage, e‑invoicing page, integrations/pricing page; ≤4 fetches). Rule: never guess; unconfirmed fields are `null`; `confidence` records how much was confirmed; `sources` lists every URL actually fetched.
3. **Normalise** (`build.py`) — enforces vocabularies (ERP names, segments, pricing models, support channels, types), attaches accreditation numbers, promotes an ERP vendor's own product to its native connector (Tally, Zoho Books, Focus, SAP), trims text, caps sources at five, and fails the build if provider ids are not contiguous 1…N.
4. **Regulatory facts** — `reg_facts.json` is the sourced record; the page carries a curated copy (`REG` in the template) with the three cohorts and the six penalty schedule items. Change `REG` when the law changes; keep `reg_facts.json` as the audit trail.
5. **Inject** — the dataset is minified and placed at the `/*__DATA__*/[]` marker. `CONFIG` values (share URL, adviser WhatsApp, email, name) are set by build flags.

## 6. Runtime engines (all in `template.html`)

### 6.1 Scoring engine — `score(provider, answers)` → `{score 0–100, reasons[], cautions[]}`

| Component | Max | Rule |
|---|---|---|
| ERP integration | 35 | native connector 35 · documented API/middleware 22 · generic API only 12 · nothing 5. "Other/in‑house ERP" scores on Custom API (30) or breadth of list (22). "Excel/no ERP" scores on CSV upload (32), web portal (30) or being an ERP vendor (24). |
| Business size | 20 | large → enterprise/mid‑market 20 else 8 · SME/unsure → sme/micro 20, mid‑market 12, else 6 · government → government 20 else 6 |
| Volume vs pricing model | 12 | <100/month: free tier 12, published plans 10, metered models 8, quote‑only 4 · >10k/month: subscription/tiered 10, quote‑only 9, per‑invoice 7 · mid volumes: published 10 else 8; unknown pricing 5 (7 for large businesses, who expect quotes) |
| Multi‑entity | 10 | one entity: flat 8 · several: confirmed 10, enterprise EDI/Big Four with no statement 7, unstated 4, single‑entity product 0 |
| Free zone handling | 8 | mainland: flat 6 · free zone/both: explicit free‑zone support 8 else 4 |
| KSA/GCC | 5 | GCC yes: ZATCA experience 5, unstated 1, none 0 · UAE only: flat 3 |
| Priorities | 10 | each chosen priority worth 4 raw points (published pricing, onboarding claim, Arabic UI, dedicated/24‑7 support, advisory, multi‑country, trial), normalised to 10; none chosen → flat 5 |
| Confidence | ×0.92 | `low` confidence trims the total and adds a caution |

Every rule that fires appends a plain‑language reason or caution, so the card explains its own number. Fit bands: ≥78 strong · ≥60 good · ≥42 partial · else weak. Ties break on confidence, then name.

### 6.2 Deadline engine
Cohort from the size answer (`unsure` → SME dates, flagged). Days to ASP appointment and go‑live are computed live against Asia/Dubai end‑of‑day. Header chips count down the two appointment deadlines and switch to "closed" after they pass.

### 6.3 Exposure engine
Monthly exposure per Cabinet Decision 106/2025 schedule: AED 5,000 (no ASP / not implemented) + min(invoices×100, 5,000) + min(credit notes×100, 5,000); the AED 1,000/day notification items are stated but not summed. The page flags that CD 173/2026 has been announced but not published.

### 6.4 Checklist engine
14 baseline items plus conditional items: beneficiary field (free zone), group rollout + tax‑group grace (several entities), ZATCA alignment (GCC), sovereign split (government), revenue confirmation (unsure). Ticks persist per device in `localStorage`.

### 6.5 Share token
`q` + size(1) + ERP index(2) + zone(1) + entities(1) + volume(1) + GCC(1) + priorities bitmask(3) — letters and digits only, because the artifact host passes only plain `#anchor` tokens through to the page. Reopening a link restores results immediately.

### 6.6 Partner mode
A partner token `p-<whatsapp digits>-<firm name, spaces as _>` can ride in the same hash as the answers, separated by a dot (`#p-9715…-Al_Hilal_Accounting.q1051110065`). When present: a banner names the partner with a WhatsApp button, the results CTA becomes "Message <firm> on WhatsApp" with the visitor's summary pre-filled, the summary records "Shared via: <firm>", and every link the visitor copies or forwards keeps the partner token, so attribution survives forwarding. Partners generate their own link in the "Brand this tool for your clients" card; nothing about the rankings or data changes, which is what keeps the tool neutral while letting a hundred firms distribute it under their own name. No registry and no backend: the link is the record.

### 6.7 Directory & compare
All providers, searchable across name/origin/ERPs/countries/pricing text; filters by type, ERP, published pricing, trial, KSA, Arabic; sort by fit (after answers), name or information depth. Compare up to three side by side across 18 attributes.

## 7. State model

| Scope | Storage | Contents |
|---|---|---|
| Session | in‑memory `state` | step, answers, compare set, directory filters |
| Device | `localStorage` (try/catch, degrades silently) | answers, checklist ticks, done flag |
| Link | URL hash token | answers only; no personal data |
| Hot reload | `window.claude.hot` snapshot (artifact host only) | same as device state, so republishes do not lose a visitor's place |

No personal data is ever written anywhere by the page.

## 8. Hosting

* **Now:** Claude Artifact (private until shared from the page's Share menu; share a public link for forwarding). The artifact host wraps `dist/asp_selector.artifact.html` in its own skeleton, enforces a CDN allow‑list (Google Fonts only), blocks `window.print`, `alert`, embeds, downloads and most custom‑scheme links — the page is built within those limits.
* **Later:** copy `dist/index.html` to any static host or a sub‑domain. Everything that the artifact sandbox blocks (analytics, a form endpoint, print, embeds, query‑string partner branding) becomes available there without code changes to the engines.

## 8a. Companion tool: E-Invoice Data Check (`tools/validator/`)

Same design system, same partner-token convention, same no-server rule. Input: a customer list and/or an invoice register as CSV (parsed in page) or Excel (SheetJS 0.18.5 from cdnjs), or pasted rows; headers are auto-mapped to fields through a synonym table and corrected in a mapping UI. Checks: buyer TRN presence and format (15 digits, prefix 100), duplicate TRNs across names and names across TRNs, missing address/country, invoice-number uniqueness, buyer TRN on each invoice (inherited from the master by name), VAT = 5% of net unless categorised, totals, zero-VAT lines without a category, negative documents not issued as credit notes, foreign currency, dates, decimal precision. Output: readiness score (100 − 60·critical − 25·major − 10·minor, as row shares), invoices that would be rejected and the receivables on them, findings with examples and fixes, an ordered fix plan, a counts-only copyable report, WhatsApp CTA. Sample data with planted faults renders at rest; real data replaces it entirely. Nothing leaves the browser.

## 9. Extension points (not built)

1. **Lead storage** — a small form endpoint (Cloudflare Worker + KV, Supabase, or a Google Sheet via Apps Script) receiving `{answers, top5, contact}`; add a `fetch()` in `renderShare()` on the own‑domain build only.
2. **Partner registry** — on own domain, replace the hash token with a stored partner record (logo, email, calendar link) and per-partner analytics.
3. **Analytics** — privacy‑light analytics (Plausible/Umami) on own domain; count completions, shares, CTA taps.
4. **Arabic UI** — strings are already isolated in `Q`, `REG`, checklist items and labels; add an `ar` dictionary and `dir="rtl"` toggle.
5. **Data refresh automation** — a scheduled job that re‑fetches the MoF register, diffs provider ids, and opens research tasks for new entries.
6. **Readiness score** — turn the checklist into a 0–100 readiness index shared alongside the provider shortlist.

## 10. Operating runbook

* **Weekly:** open the MoF register; if the count or any accreditation number changed, add/retire providers in `data/raw/`, rebuild, republish. Bump `CONFIG.dataAsOf` and the "as of" strings.
* **On a legal change:** update `REG` in the template and append to `reg_facts.json` with the source URL.
* **Build:** `python3 build/build.py --share-url <artifact or domain URL> --adviser-whatsapp 9715XXXXXXX --adviser-email you@firm.com`
* **Test:** `cd tests && npm install && npm test` (exit 0 = pass).
* **Publish:** republish `dist/asp_selector.artifact.html` to the same artifact URL, or deploy `dist/index.html`.

## 11. Known limitations

* 15 of 67 providers had thin public sites and carry `low` confidence; their scores are trimmed and flagged. Corrections from providers are the cheapest data upgrade — and a natural referral conversation.
* Cabinet Decision 173/2026 (penalties) is named in the MoF October 2026 deck but unpublished; amounts shown are the last published schedule.
* The link between e‑invoicing data and Qualifying Free Zone Person status is not stated in any official source; the page frames it as practical inference.
* Pricing is published by only five providers; most scores in the volume component rely on the pricing *model* rather than amounts.
