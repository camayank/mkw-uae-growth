# Decisions

## Made in this codebase

**D1. MKW Advisors is the merchant of record for reseller services.** The client contracts with and pays
MKW Advisors; partners are subcontractors paid their own cost. This keeps one price and one invoice for the
client and makes margin a commercial matter, not a disclosed commission. Regulated services (FTA tax agency,
statutory audit, liquidation) use the **agent model**: the licensed firm is the provider and MKW's
coordination fee is shown separately, because those services cannot be resold.

**D2. Integer fils and basis points everywhere.** No floating point in money. Rounding happens once, at the
end of each rule, and splits use the largest-remainder method so parts always add up to the whole.

**D3. Postgres enforces who sees what, not only the application.** Row-level security and column grants per
role mean a bug in a query cannot leak margin to a client or the client price to a partner. Writes go through
server-side commands that authorise in code first, then run as the platform role.

**D4. One price rule.** `max(cost × (1 + rate), cost + floor)`, rounded up to AED 50, capped at
1.25 × market mid; a line whose cap would cut margin below the floor goes to ops review. The same rule prices
change orders. Rates and floors per category live in the database (seeded from the Sheet).

**D5. Allocation protects margin before it spreads work.** The fairness cap (35% of a month's jobs) only
re-routes to a partner who passes every hard check *and* whose own cost is no higher than the cost the client's
price was built on. This was added after the browser smoke test showed a re-route to a dearer partner producing
a negative margin line; `exceptions.test.ts` now fails if it comes back.

**D6. Milestones close only on evidence.** A step moves `evidence submitted → MKW check → client approval`.
"Done" without the required evidence types is refused. Clients who do not respond are auto-approved after 5
working days, which is in the client terms.

**D7. Partners are paid from money received.** 40/40/20 staged payouts become eligible on milestones and on the
client's payment; only finance or the founder can release them.

**D8. Append-only audit chain.** Every state change writes an event hashed with the previous event's hash. The
audit screen checks the chain.

**D9. No build step for the web app.** Plain ES modules served by the API keep the starter easy to run and
audit. Move to a framework when the screens outgrow this, keeping the API unchanged.

**D10. Application clock.** Database timestamps use `app_now()`, which follows the server's clock (or a test
clock) so SLA rules and stored times agree. Sessions and sign-in codes use real database time.

**D11. Passwordless sign-in.** Six-digit email codes, hashed, 10-minute life, 5 attempts per code, 5 codes per
account per hour, per-IP limits on the endpoints. Sessions are 14-day HttpOnly cookies.

## Open for the owner

1. **Margin rates and floors per category.** Seeded from the Sheet (setup 20% / AED 500 and so on). Confirm.
2. **Fairness cap and quality bar.** 35% and 60/100. Lower the cap to spread work faster; raise the bar to
   protect quality.
3. **Deposit size.** 50% of fees plus all government fees. Some free zones need full payment up front.
4. **Service guarantee.** Client terms refund [10]% of fees if a step is more than 5 working days late. Confirm
   the figure and whether the partner bears it.
5. **Payment provider.** Network International, Telr, Checkout.com or Stripe (UAE). The webhook is generic.
6. **Hosting region and provider** (see DEPLOY.md, data residency).
7. **Whether partners may see the client's company name before accepting.** Today they see only emirate, zone
   and the services; the name appears after they accept and become a party.
