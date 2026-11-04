# Bloat review: MASTER

Read-only review of the repo by six reviewers. Nothing in the repo was changed. Full evidence for every finding is in `areas/0N-*.md` (same folder); this file is the index, the corrections, and the decisions that are yours to make. Tick the `Decision` box in the area file, or in the tables below.

Legend: Risk SAFE = nothing references it; CHECK = confirm intent; RISKY = touches runtime, deploy or sign-off. "Verified" = I re-checked it myself after the reviewer reported it.

---

## 1. Corrections to reviewer claims (read first)

| Claim | Reality |
|---|---|
| PLT area: "`exceljs` and `jszip` are live in the Lambda because the sign-off compile-ready check uses `xlsx.ts`" | **Wrong.** The Lambda path imports only `compiler/types.ts` and `compiler/readiness.ts` (verified by grep); neither imports `xlsx.ts`. CORE-05 and CMP-06 are right: the two packages ship in the image (about 24 MB) but the Lambda never loads them. |
| TST-04: "`tests/fixtures/logic/v1.json` is a duplicate of `logic-model/.../v1.json`, delete the fixture" | **Do not delete the fixture.** `logic-model/` is gitignored (`.gitignore:19`), so the *tracked* fixture is the only copy CI and a fresh clone have. The duplicate is the ignored local one. Downgraded to KEEP. Note: the working tree currently shows large uncommitted edits to this fixture by someone else, so the two may now differ. |
| TST-01 / TST-02 timings | Measured while the other reviewers ran vitest at the same time, so about 5x slower than normal. Trust the ratios (which files dominate), not the seconds. |

## 2. Verified by me

- **PLT-01 (biggest dev-side win):** `Backend/.dockerignore` says `node_modules`, which only matches at the context root. `compile-demo/preview/node_modules` (244 MB) and `compile-demo/tools/node_modules` (213 MB) are sent into every Docker build and counted by the CDK asset hash. About 457 MB. CI is unaffected.
- **REPO-01:** `cross-check/` `prepare_input.py`, `build_flow.py`, `input_blocks.json` and `extraction_output.json` are byte-identical to the `extraction/` copies. So the "cross-check model output" is not a second model's output, and comparing the two folders compares a file with itself.
- **CMP-01 to CMP-05:** nothing in `Backend/tests`, `src`, `scripts` or CI references `compile-demo/output` or `pipeline-demo/output`.
- **CMP-07:** `compiler/index.ts` has no importer.
- **CORE-01 / CORE-02:** the only deployed `RUN_MODE` is `lambda` (`Infra/lib/lambda-stack.ts:84`, `Dockerfile:43`).

Everything else below is the reviewers' claim, supported by the grep evidence in their area files, but not re-checked by me.

---

## 3. Decisions only you can make

| # | Decision | Saves | Why it is yours |
|---|---|---|---|
| D1 | Remove `RUN_MODE=container` and `RUN_MODE=agentcore` (CORE-01, CORE-02) | about 330 src lines, about 400 test lines, `@aws-sdk/client-sqs` | Nothing deploys them, but the project notes once said "EC2 containers", and the compile job may want a container host. Removing means committing to Lambda-only. |
| D2 | Remove the whole AgentCore option (PLT-02): `AgentService/`, `model/agentcore*.ts`, the Infra stack and tests, the wire-drift test | about 1,320 code and test lines, about 3,100 lockfile lines, `@aws-sdk/client-bedrock-agentcore` (2.6 MB) | AgentCore is optional and unapproved (DEC-008), but the team said it prefers it. Keep or drop is a product call. |
| D3 | Move `exceljs` and `jszip` to `devDependencies` (CORE-05 = CMP-06) | about 24 MB off the Lambda image | The compile build host would then need a full `npm ci`. Reverses if you ever compile inside Lambda. |
| D4 | Stop tracking generated demo output (CMP-01 to CMP-05) | about 3.3 MB | Nobody references it. Only "reviewers browse the report on GitHub" would argue for keeping `flow.html`/`REPORT.md`. |
| D5 | Delete `claude_team/` pieces (REPO-07) | up to 50 to 80 KB | `decisions.md` is cited by code, tests and READMEs (DEC-014, 015, 019, 020...). **Keep it and the BRD.** Only `integration.md`, `system-design.md` and `artifacts.md` are candidates. |
| D6 | Drop the offline Python experiment pipeline (REPO-02, CHK-09) | about 50 KB plus `compare_outputs.py` 376 lines, `requirements.txt` | Nothing runs it, but it is how the extraction was validated. |

## 4. Safe, low-debate wins

| ID | What | Size |
|---|---|---|
| PLT-01 | Fix `.dockerignore` (`**/node_modules`, plus the demo folders) | 457 MB build context |
| REPO-01 | Delete the four duplicate files in `cross-check/` (one-line path change in its scripts) | 110 KB |
| CMP-07 | Delete `compiler/index.ts` | 8 lines |
| CHK-03 | Delete `snapshotSha`/`hashableModel` (tests only, and hashes differently from the real `modelSha`: a trap) | about 70 lines |
| CHK-04 | Delete `validation/checkInputs.ts` and the `validation/index.ts` barrel | about 100 lines |
| CHK-07, CHK-08 | Twin helpers, unused exports | about 25 lines |
| CORE-06 | Move test doubles out of `src`/`dist` | about 60 lines |
| REPO-03, REPO-08, REPO-11 | `requirements.txt` (if D6), `Frontend/sample.txt`, flesh out the root README | tiny |
| REPO-04 | Fix `Backend/README.md` "Not verified" section: it says reject is not built (`server.ts:293` has the route), hosting undecided (DEC-014 decided), image never built (CI builds it), and cites a gitignored spec | about 10 wrong lines |
| REPO-05 | Merge the four overlapping deploy docs into `DEPLOYMENT.md`; drop `DEPLOY_CHECKLIST.md` | 6 to 8 KB |
| PLT-04 | CI: stop installing and testing Backend twice | about 25 workflow lines |
| TST-06, TST-07 | Merge the three loader helpers and the `redteam2` files into their base files | about 100 lines |

## 5. Performance wins (runtime, not size)

| ID | Issue | Effect | Risk |
|---|---|---|---|
| CHK-01 | Grid is enumerated twice and every point evaluated 5 or more times per save, inside the HTTP request | check phase roughly 3 to 5x faster; very likely the cause of the 30 s test timeouts | CHECK: results must stay identical, it backs the "every combination checked" claim |
| CHK-02 | Version chain loaded sequentially, booklet re-read per save | k-1 fewer round trips per save | RISKY if it leaks into `sign`/`verifyLocked`: keep those recomputing |
| CORE-03 | Page images read (extract) and written (ingest) one at a time, up to 200 S3 round trips each | seconds per run | SAFE if page order is preserved |
| CORE-04 = PLT-03 | Both model SDKs (Strands 7.9 MB, AgentCore 2.6 MB) and SQS load at every cold start | cold-start time, unmeasured | SAFE, 3-line change |
| TST-01, TST-02 | Three test files take about 63% of test time because each test re-runs the full checks | suite time | TST-02 touches sign-off tests: change fixture construction only, keep every assertion |
| PLT-05 | CI docker job: three builds, two under QEMU arm64 | 5 to 10 min CI estimate | CHECK |
| CORE-07 | `Scan` for resume sweep and `GET /runs` | fine for now; grows with run count | CHECK |

## 6. Leave alone (reviewers checked, not bloat)

- Engine retry, attempt cap and lease layers (CORE-08): each protects cost or correctness.
- Sign-off tests at three layers (TST-10), the 33 skipped DynamoDB tests, wire-contract tests.
- The two IAM managed policies, the `API_ROUTES` mirror and visibility-timeout values (PLT-07).
- `golden-proposed.json`: used at runtime by `src/signoff/checkInputs.ts:38` as the default golden path.
- `src/compiler/template` (0.5 KB), lockfiles for the compile tooling (CMP-08), the schemas in `logic/schema.ts`, `fill/draftSchema.ts` and `validation/context.ts` (different on purpose).
- `extraction/extraction_output.json` and `input_blocks.json`: used by tests and `fillLive.ts`.

## 7. Totals if every SAFE and CHECK item is accepted

| | Amount |
|---|---|
| Tracked repo size | about 3.5 MB (generated output 3.3 MB, duplicates 110 KB) |
| Source and test lines | about 2,300 (AgentCore 1,320, run modes 730, dead checks code about 200, tests about 100) |
| Lockfile lines | about 3,100 (AgentCore option) |
| Lambda image | about 24 MB (`exceljs`, `jszip`) plus SQS and AgentCore SDKs if D1/D2 |
| Docker build context on dev machines | about 457 MB to under 5 MB |

## 8. Full finding index (decision boxes live in the area files)

| Area file | IDs |
|---|---|
| `areas/01-core.md` | CORE-01 to CORE-09 |
| `areas/02-checks.md` | CHK-01 to CHK-09 |
| `areas/03-compile.md` | CMP-01 to CMP-09 |
| `areas/04-tests.md` | TST-01 to TST-12 |
| `areas/05-repo.md` | REPO-01 to REPO-11 |
| `areas/06-platform.md` | PLT-01 to PLT-09 |

Thin areas (low confidence, skimmed): PLT-06, PLT-09, REPO-07 (`errors.md` and `artifacts.md` not read closely), CMP-09, TST-05, TST-08, TST-09.
