# Area 04: Tests (TST)
Scope: Backend/tests/ (84 files incl. helpers/, fixtures/), Backend/vitest.config.ts, test-related npm script. Ran the full suite once with the json reporter (`--outputFile` into the review folder, `tst-times.json`; repo untouched).
Not covered: no line-by-line read of every test body; overlap judged from test titles, imports and the mutation-id cross references. The 33 DynamoDB-Local-only skips in tests/store/dynamoStore.test.ts are left alone.

Summary: The suite is healthy on correctness but slow for one structural reason: 3 files own about 63% of test time, and all three re-run the full `runChecks` (exhaustive answer grid) once per test with no shared result. Biggest win is runtime, not lines: redteam1.test.ts (~294 s summed, of 1045 s in this run, which was inflated about 3x by other reviewers running vitest at the same time; use the ratios, not the seconds), hardening.test.ts (~214 s), signoff.test.ts (~149 s). Line deletion potential is small (roughly 300 to 600 lines plus about 50 KB of fixtures); most overlap is intentional red-team regression and sign-off guarding, so I mark it RISKY or CHECK.

Timing table (summed test durations, contended run, top files): redteam1 294 s (83 tests, median 1.4 s, one test 57 s), signoff/hardening 214 s (30 tests, median 4.9 s, `officer "alice" ...` 38 s), signoff/signoff 149 s (25 tests, median 3.9 s), api/signoff 54 s (25), validation/severityOrder 39 s (15), compiler/flow 31 s, integration/pipeline 29 s (1 test), validation/dangerSignCoverage 22 s, compiler/compileSnapshot 21 s, logic/flow 18 s, validation/deadInputs 17 s (3 tests), compiler/compileLocked 17 s (4 tests). Everything else under 16 s. Total about 1045 s vs about 195 s reported uncontended, so the same ratios apply.

## Findings

### TST-01  redteam1.test.ts runs the full checks 1 to 3 times per mutation (about 28% of all test time)
- Category: TEST (PERF of the suite)
- Where: Backend/tests/validation/redteam1.test.ts:33-60 (`blockingOf`, `caughtBy`), 93 mutations in redteam1.mutations.ts
- Evidence: Every `FIXED_PROD` case (25 mutations) calls `caughtBy` twice (full=true and full=false), each a fresh `runChecks`; every `ALREADY_PROD` case (about 58) calls it once; `BASE_OTHER` adds 2 more. About 110 full `runChecks` calls, no memoisation. Tests carry `{ timeout: 60000 }`; M77_grid_explosion alone is 57 s contended. Reported times: median 1.4 s per test, 83 tests, 293 s total.
- Proposed action: (a) memoise `blockingOf(name, full)` in a Map (FIXED_PROD for `full=true`/`false` and the M00 baseline are repeated); (b) for the ALREADY_PROD list, which only asserts "still blocked", run the one check that catches it (or the existing per-check test) instead of the whole `runChecks`, and keep one full-chain pass for FIXED_PROD; (c) cap or skip M77 (20 unused yes/no questions = 2^20 grid) in the default run or use a smaller N that still trips the guard.
- Size: about 100 to 150 s of suite time (contended), 0 lines removed
- Risk: CHECK (these are red-team regressions of clinical-safety checks; keep every mutation, only change how it is evaluated)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-02  Sign-off tests recompute the checks per test (hardening, signoff, api/signoff: about 60% of the rest of the time)
- Category: TEST (PERF of the suite)
- Where: Backend/tests/signoff/hardening.test.ts (median 4.9 s), signoff/signoff.test.ts (median 3.9 s), api/signoff.test.ts (54 s), compiler/compileLocked.test.ts, scripts/compileLocked.test.ts, integration/pipeline.test.ts; helpers in signoff/helpers.ts (`seed`, `draftV1`, `fullyResolved`)
- Evidence: `draftV1()` resolves the real draft against the real extraction on every call, `officerFixed()` and `fullyResolved()` rebuild on top of it, and every sign/save inside `Signoff` runs `runChecks` over a fresh MemoryArtifactStore, so the checks cache (key = CHECKS_VERSION + inputs sha) never hits across tests. This is the cause of the 30 s timeout bump in commit f220b19. Slowest single tests: hardening "officer alice then clinician alice​" 38 s (a `describe.each`/loop of normalisation variants, each running a full sign flow), signoff "a new version starts over" 38 s.
- Proposed action: memoise `draftV1()`, `officerFixed()`, `fullyResolved()` and `testGoldenCases()` at module level (they are pure and models are treated as immutable; return `structuredClone` if a test mutates). Better: pre-seed the artifact store with a precomputed findings record for the unchanged `fullyResolved` sha where the test is not about the checks themselves. For the userId-normalisation variants (hardening.test.ts:170) test the normaliser as a unit (already covered at :158/:163) and run the end-to-end flow for one variant only.
- Size: probably 40 to 60% of the 3 files' time, 0 lines removed
- Risk: RISKY (sign-off, separation of duties, lock tests: keep every assertion, change only fixture construction)
- Confidence: MED (timing measured, effect of memoising not measured)
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-03  redteam1 FIXED_PROD list re-tests behaviour already asserted in per-check files
- Category: TEST (overlap)
- Where: validation/redteam1.test.ts FIXED_PROD (25 M-ids) vs validation/dangerSignCoverage.test.ts (cites M11, M12, M13, M80, M89, M33, M53, M07, M08, M91; 9 refs), severityOrder.test.ts (M19, M22; 5 refs), ageGroups.test.ts (M28, M66; 4), followUpConsistency.test.ts (M43, M45, M47; 4), schemaReferences.test.ts, fieldNames.test.ts, reachability.test.ts
- Evidence: grep of `M[0-9][0-9]` ids across tests: 93 mutation ids defined in redteam1.mutations.ts (115 lines, 14.6 KB); the same ids appear in 8 per-check test files that assert the same mutation yields the same blocking code from the single check. redteam1 asserts only "some logic check blocks", which is weaker than the per-check test.
- Proposed action: for ids already pinned by a per-check test, drop them from FIXED_PROD (keep in ALREADY_PROD style list only if the per-check test does not exist). Net: fewer runChecks calls and a shorter list. Do not remove the mutations file itself; it is the only place the 60+ other mutations live.
- Size: about 10 to 15 ids, about 20 lines, plus 20 to 40 s suite time
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-04  tests/fixtures/logic/v1.json is a byte-identical copy of logic-model/pathways/cough_fast_breathing/v1.json
- Category: DUP
- Where: Backend/tests/fixtures/logic/v1.json (718 lines, 19 KB); original ../logic-model/pathways/cough_fast_breathing/v1.json (also a root v1.json exists, not diffed)
- Evidence: `diff` of the two = 0 lines. Read by tests/logic/helpers.ts, tests/compiler/helpers.ts, logic/clinicianOrigin.schema.test.ts (3 loaders, plus validation/helpers.ts via logic/helpers). tests/logic/fill/realDraft.test.ts already reads the pathways copy directly, so the repo already depends on it from tests.
- Proposed action: keep as is if the Backend Docker/CI build context excludes ../logic-model (check Dockerfile/CI context first), otherwise point the 3 loaders at the pathways file and delete the copy. README at fixtures/logic/README.md says it is a deliberate copy.
- Size: 19 KB, 718 lines
- Risk: CHECK (CI working dir and Docker context may not include logic-model)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-05  tests/fixtures/validation/redteam1-golden.json is a frozen near-copy of golden-proposed.json
- Category: DUP
- Where: Backend/tests/fixtures/validation/redteam1-golden.json (about 290 lines) vs tests/fixtures/logic/golden-proposed.json (348 lines)
- Evidence: `diff` = 138 lines, i.e. mostly the same 17 to 18 cases with the same notes; only used by validation/redteam1.test.ts:28. golden-proposed.json itself is NOT removable: src/signoff/checkInputs.ts:38 uses it as DEFAULT_GOLDEN_CASES_PATH at runtime and the Lambda reads it.
- Proposed action: derive redteam1's cases from golden-proposed.json by filtering ids the old six-rule draft knew, instead of a second file; or keep if the old outcome ids differ materially (the diff shows they do for several cases, so confirm before merging).
- Size: about 12 KB
- Risk: CHECK
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-06  Three near-identical loader helper modules and two `demoSettings`
- Category: TEST (helpers)
- Where: tests/logic/helpers.ts (`rawV1`, `v1`, `rawGolden`), tests/compiler/helpers.ts (`rawV1`, `parse`, `v1`, `demoSettings`), tests/validation/helpers.ts (`demoSettings` reading compile-demo/settings.demo.json, `rawGoldenCases`, `rawV1` re-import, `v1Copy`), tests/signoff/helpers.ts (`testGoldenCases` re-reads golden-proposed.json)
- Evidence: `rawV1` is defined twice (logic, compiler) with identical bodies; `demoSettings` defined twice with different bodies (an inline object in compiler/helpers.ts vs the file compile-demo/settings.demo.json in validation/helpers.ts) and imported by signoff/helpers.ts from the compiler one; golden file parsed by 4 separate loaders; every test calls `JSON.parse(readFileSync(...))` of the same 19 KB v1.json again (no cache), see about 30 test files in the grep.
- Proposed action: one `tests/helpers/fixtures.ts` exporting cached `rawV1()` (structuredClone on return), `v1()`, `rawGolden()`, `demoSettings()`; the per-folder helpers re-export. Cached parse also trims runtime a little. Decide which `demoSettings` is canonical; the two can drift (the file one is also shipped to compile-demo).
- Size: about 40 lines
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-07  Redundant per-bug-fix "redteam2" files split from their base file
- Category: TEST (overlap / structure)
- Where: validation/numberGrounding.redteam2.test.ts (83 lines) vs numberGrounding.test.ts (218); validation/clinicalText.redteam2.test.ts (41) vs clinicalText.test.ts (52); logic/fill/resolve.redteam2.test.ts (116) vs resolve.test.ts (355); plus redteam1.test.ts
- Evidence: Each redteam2 file tests the same source module as its base file (numberGrounding, clinicalText, resolveDraft), against the "resolved real draft" instead of v1.json, with the same helper style (`D/O/Q` finders re-declared in each: 4 files define their own `Q`/`O`/`D` lambdas). They are not duplicates of assertions, only of file structure. Merging saves repeated imports/finders, not coverage.
- Proposed action: merge each redteam2 file into its base as a second `describe` and share one finder helper (`tests/validation/finders.ts`: Q, O, D, R). Optional, cosmetic.
- Size: about 60 lines
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-08  Low-value tests of constants and plain wiring
- Category: TEST
- Where: contract/routes.test.ts (41 lines: asserts `routes.runs()==="/runs"` etc.), contract/agentcore.test.ts routes block (lines 5-18: `routes.ping()` is "/ping"), logic/golden.test.ts first test (`length >= 14`, unique ids), metrics/cost.test.ts (41), logic/hash.test.ts (41), shutdown.test.ts (44), config.test.ts (118)
- Evidence: these re-state the literal definitions of path strings and counts. They guard the wire contract only weakly, since contract/noRouteStrings.test.ts and the API tests (server.test.ts) hit the real routes.
- Proposed action: delete the "builds concrete paths" literal assertions in routes.test.ts and agentcore.test.ts routes blocks only if server.test.ts and the AgentCore invocation tests exercise the same paths; keep the schema accept/reject tests (PingResponse etc.). Leave config/shutdown/cost/hash unless the owner wants more cuts. I did not read their bodies in detail.
- Size: about 40 to 60 lines
- Risk: RISKY (wire contract; only remove path-literal tests, not schema tests)
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-09  Golden-case evaluation asserted in four places
- Category: TEST (overlap)
- Where: logic/golden.test.ts (every proposed case evaluates to its expected outcome and rule on v1.json), validation/goldenCases.test.ts ("proposed cases all agree with v1.json", count 20), validation/realPair.test.ts ("all cases agree; every outcome has a case"), validation/checkInputs.test.ts (loads the same file), signoff/hardening "golden cases supplied as an input gate the clinician"
- Evidence: logic/golden.test.ts and goldenCases.test.ts:12 both assert all proposed cases agree with v1.json (interpreter directly vs via the check). realPair.test.ts:63 asserts the same a third time in the whole-chain run.
- Proposed action: keep logic/golden.test.ts (interpreter level, one `it.each`) and the gate test in hardening; drop the "all agree" sub-assertion from goldenCases.test.ts:12 or realPair.test.ts:63. Small.
- Size: about 15 lines
- Risk: CHECK
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-10  Sign-off behaviour tested at three layers (class, API, hardening)
- Category: TEST (overlap, intentional)
- Where: signoff/signoff.test.ts (25 tests) vs api/signoff.test.ts (25) vs signoff/hardening.test.ts (30): e.g. "same person as officer and clinician refused" (signoff.test.ts:109, api/signoff.test.ts, hardening.test.ts:170), "superseded new version starts over" (signoff.test.ts:176 and hardening.test.ts:438), "reject after officer signed" (api/signoff.test.ts, hardening.test.ts:422)
- Evidence: titles overlap on 403 self-approval, 409 ordering, supersede and reject. They differ in layer (class vs HTTP status mapping vs adversarial inputs), so each has a purpose.
- Proposed action: keep all. Only trim the hardening userId variants (see TST-02) and anything that repeats the exact same sequence through the exact same layer. Listed so nobody re-audits.
- Size: 0
- Risk: RISKY
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-11  tests/helpers/resolveForDemo.ts is imported by the pipeline demo
- Category: TEST (note)
- Where: tests/helpers/resolveForDemo.ts (38 lines, "TEST-ONLY") used by signoff/helpers.ts, integration/pipeline.test.ts, signoff/hardening.test.ts and also by Backend/pipeline-demo/run.ts
- Evidence: grep of resolveForDemo: 4 test files plus pipeline-demo/run.ts and pipeline-demo/output/TRACE.md. If the pipeline demo is cut (see CMP area), the helper stays used by tests, so it is not dead either way.
- Proposed action: keep but note that a demo script depends on a tests/ path; moving it to src/ is not wanted by its own header, so leave.
- Size: 0
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### TST-12  Large fixtures read per test instead of once
- Category: TEST (PERF of the suite)
- Where: fixtures/validation/redteam1-baseline.json (1000 lines, 27 KB), fixtures/validation/old-six-rule-v1.json (376 lines, 14 KB, one user: ageGroups.test.ts:10), fixtures/logic/v1.json, extraction/input_blocks.json and extraction_output.json (real, large)
- Evidence: `realDocument()`, `realExtraction()`, `rawV1()` and `baseline()` each call `readFileSync`+`JSON.parse` on every invocation; check files such as numberGrounding, quoteGrounding, dangerSignCoverage call `matchedCtx()` once per `it`, and `matchedCtx` calls `realDocument()` which re-parses and rebuilds the document index each time. About 90 call sites in tests/validation/*.test.ts.
- Proposed action: cache the parsed raw JSON in the helper (module-level lazy) and return `structuredClone`; cache `realDocument()` (it is read-only) if `loadSourceDocument` output is not mutated. redteam1-baseline.json is a 27 KB resolved copy of the real draft already derivable via `resolveReal()` in realDraftModel.ts; consider generating it instead of committing (the redteam1 header says it is exactly that), though freezing it protects against resolver changes, so CHECK.
- Size: 0 to 27 KB, and seconds of parse time
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

## Looked at and fine
- 33 skipped tests in store/dynamoStore.test.ts (DynamoDB Local only, left alone); store/storeContract.ts is a shared contract run by memory and Dynamo stores (good, not duplicated).
- Conditional write, lease, lock, separation-of-duties tests (signoff/*, api/signoff, store contract): protective, RISKY to cut.
- contract/noRouteStrings.test.ts: cheap source scan, guards the wire contract.
- compiler/compileLocked.test.ts vs scripts/compileLocked.test.ts: unit vs job runner, different code (src/compiler/compileLocked vs scripts/compileLocked.ts); the scripts one is only worth keeping if scripts/compileLocked.ts stays (see CMP area).
- compiler/flow.test.ts vs logic/flow.test.ts: derive/describe vs compile mapping, not overlapping.
- fixtures/logic/golden-proposed.json: used at runtime by src/signoff/checkInputs.ts:38 (Lambda default golden path); do not touch.
- fixtures/fill/draft-cough.json: used by 6+ test and helper files and the integration test.
- No `.skip` or `.only` in test files other than the Dynamo skip; no snapshot (`toMatchSnapshot`) files; no giant inline literals beyond the fixture JSONs.
- vitest.config.ts: minimal, 30 s timeout is a symptom of TST-01/02, not the cause.

## Cross-area pointers
- CMP: Backend/pipeline-demo/run.ts imports tests/helpers/resolveForDemo.ts; if the demo is removed or promoted, revisit TST-11. Backend/scripts/compileLocked.ts is the only subject of tests/scripts/compileLocked.test.ts.
- CHK: src/signoff/checkInputs.ts:22 TODO still points at golden-proposed.json under tests/fixtures (runtime depends on a tests/ path; Docker image must copy it) - flagged for PLT/CORE to confirm the Lambda image includes tests/fixtures/logic/golden-proposed.json.
- CHK: `runChecks` has no cache within a process; an in-memory memo keyed by model sha plus inputs sha would also speed these tests, but that touches runtime code.
