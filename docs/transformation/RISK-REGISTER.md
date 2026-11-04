# Risk register

Risks to a safe pilot and to the transformation, with the treatment and who owns it. First written by E18 on 4 Nov 2026
from the baseline audit; updated with every outcome. Likelihood and impact are judgements (low, medium, high), not
measurements.

| ID | Risk | Likelihood | Impact | Treatment | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Audit rows can be updated or deleted by the application's own database role; deleting the newest rows is not detected | low (needs code or SQL access) | high (rule 8, trust, disputes) | E19: append-only trigger; chain head recorded nightly | build | open |
| R2 | Within a party, role limits (ops vs margin, staff vs payouts, member vs owner) rest on two layers and some paths are untested | medium | high (rule 1) | E19: a test for every path in `BASELINE-AUDIT.md` 4.2; decision T4 | build; owner for T4 | open |
| R3 | An uploaded file is not checked for what it is or for malware before another party downloads it | medium | high | E20: magic bytes, quarantine, scanner adapter; T6 | build; owner for T6 | open |
| R4 | The per-address throttle counts per process | low until two instances | medium | WAF rate rule or shared store when staging runs two tasks (gap 13) | build with staging | open |
| R5 | A future code path (the agent) sets a request, payout or change-order status that no state machine checks | medium once the agent exists | medium | Transition tables for those three before E23 gives the agent write tools | build | open |
| R6 | The AI is presented as more than it is | medium | high (mandate; trust) | Capability status on screen; outputs labelled; evaluation results only from real runs (E22, E27) | build | open |
| R7 | An AI action has a consequence without a person | low with today's code | high | The agent writes drafts and requests approval; every consequential tool needs an approval record (E24) | build | open |
| R8 | Personal data sent to an AI provider outside the UAE without a legal basis | medium once a provider is live | high (PDPL) | T5 asks the question first; redaction as in today's document checker (D54) | owner, lawyer | open |
| R9 | No verified regulatory data: the public answer is "to be verified" for every place | certain today | high (conversion) | A named verifier records first-wave facts (gap 92); E21 makes it faster | owner | open |
| R10 | Priority tier priced for speed that is not promised | certain today | medium (commercial) | E26 carries quoted working days into the offer and plan (gap 85) | build | open |
| R11 | No staging: nothing proven against real email, storage or a real database backup | certain today | high | Owner accounts (STAGING-CHECKLIST section 2) | owner | open |
| R12 | Pilot sign-offs blank (owner, lawyer, tax, verifiers, security, Arabic, partners, clients) | certain today | high (NO-GO) | `docs/evidence/E7E/GO-NO-GO.md` | owner | open |
| R13 | CI timing flakes on a busy runner make red PRs that are not real | low | low | Fixed when seen with a timeout, never by skipping (E17) | build | watching |
| R14 | Scope creep from the mandate's breadth into a rebuild | medium | high | One outcome per PR, additive only, the roadmap's order, the owner merges each | build | watching |
