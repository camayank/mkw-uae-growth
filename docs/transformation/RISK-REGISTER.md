# Risk register

Risks to a safe pilot and to the transformation, each with its treatment and owner. This version was written by E20
on 4 Nov 2026, from the baseline audit on `main` at a42c487, and is updated with every outcome. Likelihood and impact
are judgements (low, medium, high), not measurements.

| ID | Risk | Likelihood | Impact | Treatment | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Audit rows could be edited or deleted by the application's own database role | — | high (rule 8) | E19: update, delete and truncate revoked and refused by a trigger; the app logs in as a role that owns nothing, with no trigger rights. Closed for changing and removing events only; inserting them is R20 | build | closed for update, delete and truncate (E19) |
| R2 | One partner reads another's change-order cost, or partner staff see money | — | high (rule 1) | E19: migration 024, staff views, tests, smoke | build | closed (E19) |
| R3 | Within a party, role limits rest on two layers (the API), not on database grants | low | high | Tested on every path (E19); decision T4 | owner (T4) | open |
| R4 | A download route serves a file to another party (six routes untested) | low (RLS or code checks exist) | high | E21: a refusal test for each | build | open |
| R5 | An uploaded file is not checked for what it is, or for malware, before another party downloads it | medium | high | E22: magic bytes, quarantine, a scanner adapter; T6 | build; owner for T6 | open |
| R6 | The per-address throttle counts per process | low until two instances run | medium | A WAF rate rule or a shared store when staging runs two tasks (gap 13, shared rate limiting) | build with staging | open |
| R7 | A future code path (the agent) sets a request, payout or change-order status that no machine checks | medium once the agent exists | medium | E21, before E25 gives the agent write tools | build | open |
| R8 | The database owner (the master secret) switches the audit guard off, or truncates the chain's tail unnoticed | low | high | Only the migration container and a DBA hold the secret; E21 compares the chain's length night to night | build; ops | open |
| R9 | The AI is presented as more than it is (gap 7 said an adapter existed; it did not) | medium | high (mandate; trust) | E20 corrects gap 7; capability status on screen and outputs labelled (E24); evaluation results only from real runs (E29) | build | open |
| R10 | An AI action has a consequence without a person | low with today's code | high | The agent writes drafts and requests approval; every consequential tool needs an approval record (E26) | build | open |
| R11 | Personal data sent to an AI provider outside the UAE without a legal basis | medium once a provider is live | high (PDPL) | T5 asks this first; redaction as in today's document checker (D54) | owner, lawyer | open |
| R12 | No verified regulatory data: the public answer is "to be verified" for every place | certain today | high (conversion) | A named verifier records first-wave facts (gap 92); E23 makes it faster | owner | open |
| R13 | A partner-stated fee publishes with no person's acknowledgement | certain today | medium | Labelled PARTNER-STATED everywhere (E18); decision T8 | owner | open |
| R14 | Priority tier priced for speed that is not promised | certain today | medium (commercial) | E28 carries quoted working days into the offer and the plan (gap 85) | build | open |
| R15 | No staging: nothing proven against real email, storage, a real database backup or the runtime login on RDS | certain today | high | Owner accounts (STAGING-CHECKLIST, section 2) | owner | open |
| R16 | Pilot sign-offs blank (owner, lawyer, tax, verifiers, security, Arabic, partners, clients) | certain today | high (NO-GO) | `docs/evidence/E7E/GO-NO-GO.md` | owner | open |
| R17 | CI timing flakes on a busy runner make PRs red when nothing is wrong; the smoke run is at the sign-in code limit | low | low | Fixed when seen, with a timeout or by reusing a session, never by skipping (E17, E19) | build | watching |
| R18 | The mandate's breadth turns into a rebuild | medium | high | One outcome per PR, additive only, in the roadmap's order; the owner merges each | build | watching |
| R19 | Migration 025's PostgreSQL 15 branch has not been run (only 16 is installed here) | low (staging is 16) | medium | Run it once on a 15 server before relying on 15 | build | open |
| R20 | The platform role inserts an audit event directly, bypassing `audit_append`: a forged event attributed to anyone, or a malformed one that breaks the chain for good. `audit_checks` is writable too | low (needs a compromised process or a SQL bug on an `asPlatform` path) | high (rule 8, trust, disputes) | E21, first: revoke insert on `audit_events` from the application roles; an append-only `audit_checks`; a refusal test (gap 148) | build | open |
