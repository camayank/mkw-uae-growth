# Transformation decision log

Decisions about how the transformation is run, numbered T1, T2 and so on.

- Product and engineering decisions stay in `docs/DECISIONS.md` (D-records), which remains authoritative.
- A T-record that changes the product points to its D-record.
- Open decisions say who decides and what each option costs. Nothing open is acted on until it is decided.

## Decided

**T1. The mandate's work continues the E-series of outcomes.** (E20, 4 Nov 2026.) The mandate suggests P0-01 to
P1-06, while the repository already numbers outcomes E1 onwards. New outcomes take the next E-number, and
`ROADMAP.md` maps each to its mandate item. One numbering keeps `outcomes/QUEUE.yaml` the single queue.

The owner numbers outcomes as they release them: E18 was released as quote provenance and E19 as role isolation. So
this baseline audit, first drafted as E18, is E20.

**T2. Status words are the mandate's seven, each with stated evidence; no completion percentage.** (E20.)
`IMPLEMENTATION-STATUS.md` defines NOT STARTED to PRODUCTION VERIFIED and the evidence each needs. A percentage would
need an agreed method; none exists, so none is given.

**T3. Security hardening comes before the AI agent.** (E20.) An agent that acts on behalf of users must inherit limits
that are already proven.
- E17, E18 and E19 have done the first part.
- E21 (the audit insert, downloads and state rules) and E22 (upload quarantine) come before E24 to E26 (the provider
  and the agent). This is the order of work; E24 does not depend on them in the queue and could be built alone.
- E25 depends on E21, so that agent tools cannot change a status no machine checks or write the audit trail directly.

## Open (owner)

**T4. Separate database roles within a party?** (D101, gap 142.) Ops, finance and the founder share one database role
(`app_platform`), and so do partner admin and staff (`app_partner`). Since E19, every within-party rule is enforced
and tested at the API: the route guards, the visibility map and the views.
- **A. Split the roles.** `app_ops` and `app_finance` (and possibly `app_partner_staff`), with column grants that
  mirror the visibility map. This adds the database as a third layer for these pairs. Cost: a migration touching every
  grant and every `asPlatform` call site.
- **B. Keep the API split.** Two layers, now tested on every path. Cost: none now.

Recommendation: B, unless the outside security reviewer asks for A. Decides: the owner.

**T5. Which AI provider, with what monthly cap?** `lib/ai.ts` names `AI=anthropic` as the intended adapter, but no
adapter code exists (gap 7, corrected by E20). Before E24 can call a live model, the owner needs to decide:
- the provider;
- an API key, kept in the secrets store and never in code or chat;
- a monthly cap in AED;
- whether personal data may be sent, under PDPL, given the provider's region and retention terms.

Until then, E24 builds the adapter against a test double, and the screen says "AI: not connected". Decides: the
owner.

**T6. A live malware scanner?** E22 (D104) built the quarantine and the adapter: every upload's content is checked,
held until a scan finds it clean, and never served or relied on before. The only scanner is a test double, refused in
production. The options, each with its cost:
- **A. ClamAV as a side container in the staging stack.** No licence fee; CPU and memory in the task, and the signature
  updates to keep. An adapter speaks its socket protocol.
- **B. A managed scanning service.** A per-file or monthly fee; an adapter calls its API; personal data leaves the
  platform's own region unless the service runs in the UAE.
- **C. Serve unscanned files, labelled.** `UPLOADS_UNSCANNED=allow`: no cost, and every screen says "not scanned".
  Only for the pilot, and only if the owner accepts the risk in writing.

Until decided, staging holds every upload. Decides: the owner.

**T7. O16 "Agents round two" and E24 to E26.** O16 (planned) lists a fee and rule watcher, a compliance calendar
agent, a vetting assistant and a founder analyst. E24 to E26 build what those agents need: the provider, the tool
registry, the run store and approvals. Proposal: O16 keeps the specific agents and depends on E26. Decides: the owner,
when releasing O16.

**T8. Two owner decisions recorded by E18.**
- **Partner-stated fees (gap 135, D100):** should a partner-stated government fee need an acknowledgement before
  publication? Recommended: yes.
- **Emirate-wide fees (gap 140):** may an emirate-wide verified fee read VERIFIED on a free-zone request?

Decides: the owner.
