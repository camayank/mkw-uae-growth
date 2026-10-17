# O4 Catalogue and fees

Status: in-progress (branch `outcome/O4-catalogue-and-fees`, stacked on O2)

## Business result

Ops can price any of the 83 services in the Service Catalogue, every government fee a client is charged comes
from MKW's own table with a source and a verification date (or is plainly marked UNCERTAIN and stopped for a
person), and the founder changes margin rates, floors and fees from the console with an effective date, with
every change on the audit trail and earlier offers keeping the rules they were priced under.

## Scope

1. **Full catalogue.** The 20 starter codes stay as they are (tests and rate cards depend on them); 62 codes
   are added so all 83 services of the Service Catalogue tab are quotable, each with category, contracting
   model (agent for the regulated ones), billing, market mid and basis, required evidence and the Service
   Catalogue row it came from. Five new margin categories (HR, Advisory, Private Client, Growth, Other) get
   default rules marked for the owner to confirm. Catalogue screen for platform roles.
2. **Government fee table.** `government_fees`: fee per code, emirate and free zone, with source link, note,
   effective date, who verified it and when, and a confidence (`UNCERTAIN` until a named person verifies).
   A fee is **stale** 90 days after verification. Pricing uses the table for the request's emirate and zone;
   a line priced on an UNCERTAIN or stale fee goes to ops review with the reason, so it cannot reach a client
   without a person's decision. Where the table has no row the partner's stated fee is used, as before, and the
   line says so.
3. **Rules admin with effective dates.** `margin_rule_versions` holds every rate and floor with an effective
   date; pricing loads the version in force on the build date; `offers.rules_as_of` records it, so an earlier
   offer is never re-priced by a later rule. Founder-only API and screen to schedule a rule change, add or
   verify a fee and change the pricing settings (cap factor, rounding). Every change is audited with before
   and after.
4. **Sample reproduction.** Ten sample requests priced through the engine, checked line by line against the
   Offer Builder's rule (`max(cost × (1+m), cost + floor)`, rounded up to AED 50, cap 1.25 × mid), including
   the Sheet's own OF-0001 example.

## Exclusions

Verified fee data itself (needs the named verifier); scoping intelligence that picks the zone (O5); rate card
import changes; Arabic names (O9).

## Acceptance evidence

- Tests: 83 services load; every code has a rule; fee lookup by emirate and zone (zone row beats emirate row);
  UNCERTAIN and stale fees send the line to review with the reason, verified fees do not; a scheduled rule
  version applies only from its date and an offer built earlier keeps its figures; founder-only writes, finance
  and ops read, clients and partners refused at the API and the database; audit before/after; ten sample
  requests reproduce the rule to the fils.
- Smoke: catalogue and rules screens at 1280 px and 390 px; a fee added UNCERTAIN shows on the rules screen.

## Dependencies and owner decisions

- Named person who verifies fees and rules (monthly), and the margin rules for the five new categories.
- Whether the partner's stated government fee may be used when the table has none (built: yes, with a note).

## Risks

- A wrong fee in the table is charged to every client of that zone: mitigated by the verifier name and date on
  every row and the 90-day staleness rule.

## Rollback

Additive migration; `STORAGE`, notifications and the pricing formula are untouched. Reverting the pull request
leaves the extra catalogue rows in place (harmless) and returns to the single current rule per category.
