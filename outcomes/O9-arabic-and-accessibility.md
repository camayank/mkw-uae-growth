# O9 Arabic and accessibility

Status: verified-pending-merge (branch `outcome/O9-arabic-and-accessibility`, stacked on O8, 17 Oct 2026)

## Business result

A client can use Tasees in Arabic: the client screens, the public intake page and the emails they receive
read right-to-left in Arabic, with numbers, references and amounts kept legible. The Arabic wording is a
draft until an Arabic speaker the owner names has reviewed it: until then clients see English only and MKW
staff can preview Arabic to review it. Every screen for clients and partners meets WCAG 2.1 AA on the
checks a machine can make (contrast, labels, names, roles, structure) and can be worked with the keyboard
alone.

## Scope

1. **Language on the account.** `users.locale` (`en` | `ar`), chosen in the header; `/api/me` carries it.
   Arabic for clients is switched on only when the founder records the reviewer's sign-off
   (`settings.arabic` = reviewed by whom, when, note). Before that the server keeps clients on English and
   lets MKW staff preview Arabic with a visible "draft, not yet reviewed" banner. The sign-off is audited.
2. **Arabic client screens.** A translation dictionary (`apps/web/public/i18n-ar.js`) keyed by the English
   string, applied to every rendered screen (text, placeholders, labels, button names, titles) with a few
   patterns for composed strings (counts, "x of y"). Untranslated strings stay in English and are counted
   on the founder's review screen so the reviewer sees coverage. `<html lang dir>` switch; logical CSS
   (margin-inline, text-align: start) so the layout mirrors; numbers, amounts, references, emails and codes
   stay left-to-right. Public intake page in Arabic too (`?lang=ar`, only when reviewed).
3. **Arabic emails.** Arabic versions of every client-facing template, selected by the recipient's locale
   when Arabic is reviewed; the notification record keeps the locale. Partner and staff emails stay English
   (their screens are English in this outcome, per the specification).
4. **Accessibility.** Skip link; visible focus; `aria-current` on navigation; form controls labelled; the
   toast and page announce changes; tables with header scope; reduced-motion respected; colour contrast of
   every token pair at AA; buttons never rely on colour alone (badges carry text). The smoke test runs
   axe-core (WCAG 2.1 A/AA rules) on the client, partner and sign-in screens in both languages and fails on
   any violation, and drives the client's main path (sign in, open the offer, accept) with the keyboard
   only. Report: `docs/evidence/O9/axe.json`.

## Exclusions

Arabic for partner and staff screens (English by design); machine translation at runtime; Arabic PDFs
(the invoice and offer PDFs stay English until an Arabic-capable font is added — listed as a gap).

## Acceptance evidence

- Tests: locale saved and returned; a client cannot switch to Arabic before the sign-off (and is kept on
  English by the server), staff can; founder-only sign-off audited; client emails render in Arabic after
  sign-off and stay English before; partner emails never in Arabic; Arabic templates keep the brand and
  carry no English fallback placeholders; `translate()` leaves numbers, references and emails untouched.
- Smoke: Arabic screenshots of sign-in, client home, offer, engagement, compliance, intake at 1280 px and
  390 px; axe-core zero violations on each checked screen; keyboard-only acceptance path.

## Dependencies and owner decisions

- An Arabic reviewer to sign off the dictionary and the templates.

## Risks

- A wrong Arabic phrase about money or obligations: Arabic reaches clients only after sign-off, and the
  numbers themselves are never translated.

## Rollback

Additive migration; without the sign-off nothing changes for clients.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 51 core + 148 API = 199 (O8: 196); `apps/api/test/locale.test.ts` (3) |
| Arabic templates | 13 client-facing templates render in Arabic with the brand, every link and reference of the English version, no `undefined`; partner and staff templates have none |
| Gate | client `/api/me` says Arabic unavailable; `PUT /api/me/locale ar` 409; staff available as preview; ops cannot sign off (403); founder needs a reviewer name (400); after sign-off the client switches (200) and the audit event records before/after |
| Emails | offer-ready email to the Arabic-speaking client is "عروضك جاهزة" with the offer link, recorded with `locale: ar`; partner allocation email has no Arabic; withdrawing the sign-off sets clients back to English and refuses Arabic again |
| Accessibility | axe-core WCAG 2.1 A/AA: zero violations on sign-in, client home, offer, engagement, compliance, intake, partner home, partner firm, public intake (English) and client home, engagement, public intake (Arabic) — `docs/evidence/O9/axe.json`; skip link is the first focus stop; keyboard-only sign-in and navigation to the engagement |
| Screens | no Arabic switch for clients before sign-off; founder records it on Settings; client home, offer (amounts kept LTR), engagement, compliance and the public intake page in Arabic, `html[lang=ar][dir=rtl]`; no horizontal overflow at 390 px |
| Smoke | `docs/evidence/O9/log.txt` (102 checks OK); screenshots `55-client-home-ar.png`, `56-client-offer-ar.png`, `57-client-engagement-ar.png`, `58-client-compliance-ar.png`, `59-public-intake-ar.png` (1280 px), `60-mobile-home-ar.png` (390 px) |

## Could not verify

The Arabic wording itself (the reviewer's job; until then it is a draft clients cannot see); screen-reader
behaviour beyond what axe-core checks; the catalogue's service names and the PDFs remain English.
