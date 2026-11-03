# E14 Front door: the public homepage at /, the workspace at /app/

Status: verified-pending-merge (branch `outcome/E14-front-door`, on `main` at 6369b66 with E13 merged; released by
the owner on 3 Nov 2026: "start E14", after the portal assessment's point on public routing)

## Business result

A visitor who types the address, follows an advert or a search result lands on the product page, not a sign-in
screen. Clients, partners and MKW staff sign in at one clear address (`/app/`). Every link already sent, saved or
bookmarked still works. Search engines see the public pages only, each under one canonical address.

## Scope

1. **Server** (`apps/api/src/server.ts`, `registerStatic`):
   - Pages:
     - `/` serves the homepage.
     - `/app/` serves the workspace, with its files served under `/app/` as well.
     - `/intake.html` is unchanged.
   - Redirects:
     - `/selector.html` and `/index.html` (and `/app`) redirect permanently, keeping the query.
   - Errors:
     - Any other address is a 404 page.
     - An unknown path under `/app/` opens the workspace.
     - Nothing outside the web folder is served.
   - Search:
     - The public pages' canonical links are made absolute from `APP_URL` (new `appUrl` option, from `main.ts`).
     - `robots.txt` and `/sitemap.xml` are generated from `APP_URL`.
2. **Pages**:
   - Homepage: a canonical link, and `forward.js`, which sends an old workspace link (`/#/…`) to `/app/#/…` before the
     homepage draws. Its brand and Start links go to `/` and `/#quick`, and its sign-in links to `/app/`.
   - Intake: a canonical link.
   - Workspace: `noindex`.
   - New `404.html`: the way home and the way to sign in, `noindex`.
3. **Links the platform sends**: emails (English and Arabic templates) and payment links point at `APP_URL/app/#/…`.
4. **Docs**: README (where to open the demo) and DEPLOY (`APP_URL` is the site address, without a path).

## Exclusions

- Choosing the domain, DNS or a certificate: the owner's (gap 18, gap 122).
- Separate Arabic addresses with `hreflang` (gap 123).
- Any change to what the pages say or do.

## Acceptance evidence

- API (`apps/api/test/front-door.test.ts`, new):
  - **Pages:**
    - `/` is the homepage, with an absolute canonical link once `APP_URL` is set and a relative one before.
    - `/intake.html` has its canonical link.
    - `/app/` is the workspace with `noindex`.
    - Its files load under `/app/` with the right types.
  - **Redirects:**
    - `/selector.html?code=…&lang=ar` redirects to `/?code=…&lang=ar`.
    - `/index.html` and `/app` redirect to `/app/`.
  - **Errors:**
    - An unknown address is a 404 page, not the workspace.
    - Four path-traversal forms serve nothing outside the folder.
    - `/api/…` keeps its JSON 404.
  - **Search:**
    - `robots.txt` keeps `/app/` and `/api/` out and names the sitemap.
    - The sitemap lists the public pages, and there is none without `APP_URL`.
  - **Email links:** the links in the platform's emails open `/app/#/…`.
- API: the payment link and notification link tests read the new address.
- Smoke (`scripts/smoke.mjs`):
  - Every workspace visit now goes to `/app/` and every homepage visit to `/`.
  - New checks:
    - an old workspace link (`/#/home`) forwards to `/app/#/home`, signed in;
    - the homepage is at `/` and its sign-in link opens `/app/`;
    - `/selector.html` redirects to `/`, keeping the query;
    - an unknown address is the 404 page, with axe passing and no overflow at 390 px.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E14/`):

- `pnpm test` (`tests-pglite.txt`): core 147 passed; API 365 passed, 1 skipped (36 files), on PGlite.
- `pnpm typecheck`: clean (`typecheck.txt`).
- `scripts/smoke.mjs` against a fresh demo: 319 checks OK, 0 failed (`smoke-log.txt`; 313 after E13).
- Screenshots:
  - `116-not-found.png` (1280 px);
  - `117-mobile-not-found.png` (390 px);
  - `95-public-home.png` (the homepage, now at `/`).

## Dependencies

E11 (homepage), E13. No new library.

## Risks

- **A link that bypasses the homepage's forwarding** (for example, a crawler that ignores scripts) lands on the
  homepage instead of the workspace screen. Mitigated: every link the platform now sends points at `/app/` directly,
  and people with old links reach the homepage, which has a sign-in link.
- **Caches holding the old `/`**: every page is served `no-cache`.

## Owner decisions

- Open: the domain and DNS (gap 18, gap 122).

## Rollback

Revert the merge. The emails sent in the meantime point at `/app/#/…`, which after a rollback opens the workspace
through the old fallback (an unknown path served the workspace before E14).
