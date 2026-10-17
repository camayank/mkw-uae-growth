# UAE ASP Selector · E-Invoice Data Check

Two neutral, free, browser-side tools for the UAE e-invoicing mandate, built from the Ministry of Finance register and each provider's own public information.

* **UAE ASP Selector** — six questions rank all 67 accredited providers against a business's ERP, size, zone, entities, volume and GCC footprint; shows legal dates and penalty exposure; generates a readiness checklist; branded links for accountants and CSPs (partner mode).
* **E-Invoice Data Check** — drop a customer list and invoice register (CSV/Excel from Tally, Zoho, QuickBooks, SAP or Excel) and see which invoices would be rejected under the mandatory-field and arithmetic rules, the receivables at risk and the fix plan. Nothing is uploaded.

Live on Claude Artifacts: [Selector](https://claude.ai/artifact/1oLxYw21hkuTDwepoKEbwh) · [Data Check](https://claude.ai/artifact/BD4iaFiBPu8DwX2WBhHQoX) · [Market Map 2026](https://claude.ai/artifact/R4zoHjumfqj4mrLZzDbnaq) (links open once shared from their Share menus).
Static site (GitHub Pages, after first deploy): the `site_url` in `site.config.json` — selector at `/`, data check at `/check/`.

Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Data dictionary: [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md) · Corrections: [`CORRECTIONS.md`](CORRECTIONS.md) · Changes: [`CHANGELOG.md`](CHANGELOG.md)

## Folder map

| Path | What |
|---|---|
| `site.config.json` | Site URL, contact details, artifact URLs, data date. The one file to edit for a new deployment. |
| `src/template.html` | The selector: design tokens, markup, scoring/deadline/exposure/checklist/token/partner-mode/directory/compare engines. Provider data injected at build. |
| `tools/validator/einvoice_check.html` | The data check (source), with its own `test.js`. |
| `data/providers.json` | Normalised dataset shipped in the selector (67 records, built). |
| `data/reg_facts.json` | Verified regulatory facts with source URLs. |
| `data/raw/` | Research output per provider group (A–D) and the merged raw file. |
| `build/build.py` | The only build step: validate, normalise, inject, wrap, write `dist/` (stdlib; Pillow optional for the preview image). |
| `dist/` | Build output: `index.html` and `check/index.html` for the static site; `*.artifact.html` fragments for the Claude Artifact host; `og-image.png`. |
| `tests/test.js` | Selector smoke test (wizard, share token, scoring × 5 personas, directory, compare, partner mode). |
| `.github/workflows/deploy.yml` | Build → test → deploy to GitHub Pages on every push to `main`. |
| `.github/ISSUE_TEMPLATE/listing-correction.yml` | How providers request a record correction. |

## Go live on GitHub Pages

1. Create an empty repository on GitHub (public, so Pages is free), e.g. `mkwadvisors/asp-selector`, and push:
   ```bash
   git remote add origin git@github.com:<owner>/asp-selector.git
   git push -u origin main --tags
   ```
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions.** The workflow runs on the push and publishes `dist/`.
3. Set `site_url` in `site.config.json` to the Pages URL (`https://<owner>.github.io/asp-selector/`) if it differs, commit, push. Share links, the data check cross-link and the preview image all derive from it.
4. Custom domain (optional): add a `CNAME` file to `dist/` via the build (or Settings → Pages → Custom domain), point DNS, set `site_url` to the domain. Nothing else changes.

Local build and test:
```bash
python3 build/build.py          # uses site.config.json; flags override: --site-url --adviser-whatsapp --adviser-email --adviser-name
npm install && npm test         # jsdom, Node 18+
```

## Updating the data

1. Check the [MoF register](https://mof.gov.ae/en/about-us/initiatives/einvoicing/einvoicing-accredited-service-providers-asps/). New or removed providers → add or retire records in `data/raw/` (ids contiguous; the build enforces it) and the accreditation map in `build/build.py`.
2. Corrections → edit the record in its `data/raw/asp_data_*.json`, keep `sources` pointing at the proving page, set `confidence` honestly.
3. Legal change → edit `REG` in `src/template.html`, append evidence to `data/reg_facts.json`, bump `data_as_of` in `site.config.json`.
4. Push to `main`; CI builds, tests and deploys. Republish the two `*.artifact.html` fragments to their Claude artifact URLs when the artifact copies should follow.

## Design constraints worth knowing

No server by design: visitors are anonymous SME finance heads arriving from WhatsApp, so there is no login, no cookie banner and nothing stored server-side. Leads travel through WhatsApp deep links with the visitor's answers pre-filled; share links carry the answers in a hash token; partner branding rides in the same token. The Claude Artifact host additionally restricts external scripts (CDN allow-list), blocks print and downloads, and only passes plain `#tokens` — the static site has none of those limits, which is where analytics and a lead endpoint go (see ARCHITECTURE §9).

## Status (17 Oct 2026)

67 providers · 13 high / 39 medium / 15 low confidence · penalties per CD 106/2025 (CD 173/2026 announced, unpublished) · deadlines: ≥AED 50M appoint by 30 Oct 2026, live 1 Jan 2027 · <AED 50M appoint by 31 Mar 2027, live 1 Jul 2027 · government appoint by 31 Mar 2027, live 1 Oct 2027.

Code: MIT. Data: CC BY 4.0. See `LICENSE`.
