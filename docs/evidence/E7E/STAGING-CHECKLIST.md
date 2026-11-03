# E7E staging checklist

Every item the launch gate (`BUILD_PROMPT.md`, "Launch gate and operations"; `outcomes/O7-launch-gate.md`) and the
staging runbook (`docs/DEPLOY.md`) need before the pilot, in the order they unblock each other. Three states:
**done (build)** with its evidence; **waiting (person)** when the platform is ready and a named person acts;
**blocked (owner input)** when nothing can move until the owner provides an account, a credential or a decision.
No cloud resource was created, nothing was spent, nothing was sent, paid or filed while writing this (E7 phase 5).

## 1. Code and verification (the build's part)

| Item | State | Evidence or step |
| --- | --- | --- |
| Typecheck, unit and API suites on PGlite | done (build) | `SECURITY-REGRESSION.md` rows 1–3 |
| API suite on PostgreSQL 16 (the staging engine) | done (build) | row 4, `tests-pg16.txt` |
| Browser smoke test, phone width, axe (WCAG 2.1 AA), audit chain of the run | done (build) | rows 5–7, `smoke-log.txt`, `axe.json`, `verify-audit.txt` |
| Load test: allocation and payout races on PostgreSQL | done (build) | row 8, `load-test.md` |
| Pilot journeys A to F end to end | done (build) | `PILOT-JOURNEYS.md` |
| Dependency audit: production clean, development tools patched | done (build) | row 9, `audit.txt`, D89 |
| Infrastructure synthesises (both stacks, example values, no AWS call) | done (build) | row 10 |
| Container image builds and answers health checks | CI | row 11 (`.github/workflows/ci.yml` `image` job on every pull request) |
| OpenAPI contract matches the routes | done (build) | `contract.test.ts` in the suites; `docs/openapi.json` |
| Configuration checked at start (production refuses development sign-in, a missing secret, an untrusted proxy range) | done (build) | `hardening.test.ts` "refuses each misconfiguration" |

## 2. Staging deployment (the owner's inputs, then the runbook)

| Step (`docs/DEPLOY.md`, staging runbook) | State | What unblocks it |
| --- | --- | --- |
| AWS account in me-central-1 with access for the deployer; budget approved (staging costs money from the first hour) | blocked (owner input) | The owner opens the account and names the deployer ("Ask me": cloud credentials; anything that costs money) |
| Domain and DNS (`app.tasees.ae`, `demo.tasees.ae`), ACM certificate validated by DNS | blocked (owner input) | The owner provides domain and DNS access |
| `pnpm synth:check` locally; `cdk bootstrap`; `cdk diff` and `cdk deploy TaseesStaging` shown to the owner first | waiting (deployer) | Steps 1 and 2 of the runbook, after the rows above |
| `curl https://app.tasees.ae/api/health` answers `db: postgres`, `devLogin: false` | waiting (deployer) | After deployment |
| The founder account created by the one-off task | waiting (deployer) | Step 4 |
| Go-live data: five files to the bucket, **dry run shown to the owner**, then `--apply`, then a second run reporting every row unchanged, then the files deleted | blocked (owner input) | The go-live workbook, the owner decisions, and the owner's go after the dry-run report ("Ask me": any row you cannot map; show me the dry-run report before `--apply`) |
| SES: domain verified, DKIM, SPF, DMARC, out of the sandbox, both senders verified, sending key in Secrets Manager, `EMAIL=ses`, redeploy | blocked (owner input) | SES sender verification ("Ask me"); until then every message is recorded and nothing leaves |
| Alert address subscribed (`ALERT_EMAIL`, the stack's `alarmEmail`) | blocked (owner input) | The owner names the address |
| Backups: RDS daily snapshots (in the stack); `scripts/backup.sh` scheduled to the backups bucket; restore drill against a scratch server logged in `docs/RESTORE-DRILL.md` | waiting (deployer) | After deployment; the drill procedure is written and was run locally on 16 Oct 2026 |
| Demo stack with the office address range; smoke test from that address against the demo, never staging | waiting (deployer) | Step 9 |
| TLS, SES delivery, S3 in the UAE region, alerts and the payment provider checked live | blocked (owner input) | All of the above; no live readiness is claimed until they run |

## 3. People and decisions (the owner and the MKW team)

| Item | State | Who |
| --- | --- | --- |
| Named fee verifier and scoping-rule verifier; first monthly verification pass recorded (today every rule and place is UNCERTAIN and the public sees no figure) | waiting (person) | Owner names them; the coverage matrix (E7B) lists what to obtain first |
| Public-display approvals: which statements, figures and guidance notes the public may read (D80; the pilot starts with none approved) | waiting (person) | A named person on the Scoping page |
| Owner decisions confirmed on Settings and in `docs/DECISIONS.md` (margin rates and floors, deposit, guarantee, fairness cap, retention periods, holiday list, measurement notice, consent texts, report wording) | waiting (owner) | Owner |
| Lawyer: Partner Network Agreement, client terms (guarantee, auto-approval), PDPL notice and consent texts, UNCERTAIN wording, the public page's "not advice" wording | waiting (person) | Lawyer; recorded on Settings (legal texts, O10) |
| Tax adviser: disbursement treatment, invoice and credit note layout, corporate tax rules in the calendar; TRN entered so invoices issue | waiting (person) | Tax adviser; owner enters the TRN |
| Merchant account for card payments and the real adapter (O14), or bank transfer only for the pilot | blocked (owner input) | Owner's choice; bank transfer works today without it |
| AI key with a cap, or the in-memory double (no AI drafts) | blocked (owner input) | Owner's choice |
| Outside security review with `docs/SECURITY-BRIEF.md` | waiting (person) | Owner appoints the reviewer; `SECURITY-REGRESSION.md` section 3 maps the brief's eight items to the tests |
| Three partner firms at `signed` with rate cards, through the platform | waiting (person) | MKW team (the onboarding flow and the importer exist) |
| Five consenting clients told what the platform records | waiting (person) | MKW team; the consent texts above first |
| Arabic reviewer's sign-off, if Arabic launches | waiting (person) | Owner's choice (O9 gate) |

## 4. Pilot operations (during the four to six weeks)

Unchanged from `outcomes/O7-launch-gate.md`: every request priced on the platform, every offer sent from it; the
ops digest read every working day and the exception queue empty at close; weekly scorecards, delay attribution,
credits, payout run; issues logged with a number, severity, fix commit and retest, nothing fixed by hand in the
database (the nightly audit check shows if it was); one PDPL export and one erasure on a test person; one restore
drill from a real backup. Journey F and `pdpl.test.ts` are the rehearsal of the export and the erasure.
