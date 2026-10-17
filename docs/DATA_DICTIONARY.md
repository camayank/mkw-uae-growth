# Data dictionary

## Provider record — `data/providers.json` (one object per accredited ASP)

| Field | Type | Meaning | Rule |
|---|---|---|---|
| `id` | integer 1…67 | Position in the MoF register (alphabetical on 17 Oct 2026) | Contiguous; the build fails otherwise |
| `name` | string | Legal name exactly as the MoF register prints it | |
| `website` | URL | Site fetched during research | `https://` enforced |
| `accreditation` | string | MoF accreditation number | From the register, keyed by `id` |
| `type` | enum | `erp_vendor` · `tax_tech` · `accounting_firm` · `big4_advisory` · `enterprise_edi` · `fintech_platform` · `it_services` · `unknown` | Best classification from the provider's own site |
| `origin` | string | Country/region of the parent company | `""` when unknown |
| `erp_integrations.native` | string[] | ERPs with a dedicated connector, plugin or certified integration | Vocabulary: SAP · Oracle · Dynamics 365 · NetSuite · Odoo · Tally · Zoho Books · QuickBooks · Xero · Sage · Focus · Infor · Epicor · Other ERP · Custom API · Excel/CSV upload · Web portal |
| `erp_integrations.connector_or_api` | string[] | ERPs reached via generic API, middleware or file upload | Same vocabulary; never repeats a native entry |
| `erp_integrations.evidence_url` | URL | Page where the integrations were seen | |
| `segments` | enum[] | `enterprise` · `mid_market` · `sme` · `micro` · `government` | As positioned on the site |
| `multi_entity` | true/false/null | Several legal entities / TINs on one account | `null` = not stated |
| `free_zone_qfzp_support` | true/false/null | Explicit free‑zone handling mentioned | `null` = not stated |
| `ksa_zatca_experience` | true/false/null | Runs Saudi ZATCA e‑invoicing | `null` = not stated |
| `other_countries` | string[] | Countries where the provider runs e‑invoicing | |
| `pricing.model` | enum | `per_invoice` · `subscription` · `tiered` · `quote_only` · `unknown` | |
| `pricing.published` | boolean | Amounts are printed on the site | |
| `pricing.indicative` | string | Verbatim or paraphrased price text | `""` when none |
| `pricing.evidence_url` | URL | | |
| `free_trial_or_sandbox` | true/false/null | | |
| `arabic_ui` | true/false/null | Arabic interface confirmed | |
| `onboarding_claim` | string ≤140 | Provider's own onboarding‑time claim | `""` when none |
| `support` | enum[] | `24/7` · `chat` · `phone` · `email` · `dedicated_manager` · `onsite` | |
| `also_provides_accounting_or_tax_advisory` | boolean | The ASP is also an accounting/tax practice | Drives the "overlaps with your accountant" caution |
| `notable` | string ≤220 | One‑line differentiator in plain words | |
| `confidence` | enum | `high` · `medium` · `low` | How much of the record was confirmed from fetched pages; `low` trims the score ×0.92 |
| `sources` | URL[] ≤5 | Pages actually fetched for this record | Shown on the directory row |

Counts on 17 Oct 2026: 67 providers · confidence high 13 / medium 39 / low 15 · published pricing 5 · KSA experience confirmed 24 · Arabic UI confirmed 8 · trial/sandbox confirmed 15 · multi‑entity confirmed 22 · also advisory 14.

## Regulatory facts — `data/reg_facts.json`

| Key | Contents |
|---|---|
| `as_of` | Date of verification (2026‑10‑17) |
| `phases[]` | cohort, scope, `asp_deadline`, `go_live`, status, sources — pilot, voluntary, ≥AED 50M (ASP 2026‑10‑30 → live 2027‑01‑01), <AED 50M (2027‑03‑31 → 2027‑07‑01), government (2027‑03‑31 → 2027‑10‑01), B2C‑only (excluded until further decision) |
| `instruments[]` | MD 243/2025 (core system), MD 244/2025 (implementation phases), MD 66/2026 (ASP‑date extension), MD 64/2025 and MD 56/2026 (repealed accreditation rules), MD 168/2026 (current accreditation rules, pre‑approval abolished from 1 Oct 2026), CD 106/2025 (penalties), CD 173/2026 (announced, unpublished), Guidelines v1.1 and Mandatory Fields v1.0 |
| `penalties[]` | The six schedule items of CD 106/2025 with amounts, caps and notes; confirmed absences (no retention‑specific fine, no repeat‑offence escalation) |
| `scope` | In‑scope list (B2B, B2G, G2B, G2G, VAT‑unregistered, free zones, tax groups with 24‑month grace, agents, self‑billing between registrants), exclusions (sovereign government activity, airline passenger transport, exempt/zero‑rated financial services, B2C, passive holding companies), credit‑note triggers, 5‑corner DCTCE model |
| `standard` | PINT AE specification, 41 mandatory tax‑invoice fields, mandatory ASP, retention (Tax Procedures Law periods), pilot from 1 Jul 2026, accreditation counts |
| `free_zone_note` | Confirmed: free zones in scope, beneficiary field required. Unconfirmed: any QFZP data‑visibility interaction |
| `unconfirmed_items[]` | Everything the verification could not settle, so the next review knows where to look |

## Curated runtime copy — `REG` in `src/template.html`

Only what the page needs: the three mandatory cohorts and the six penalty rows. Change here when the law changes; record the evidence in `reg_facts.json`.
