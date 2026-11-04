# Area 02: CHECKS (validation, signoff, logic)
Scope: Backend/src/validation (analysis, checkInputs, runChecks, index, gates, finding, context, text, numbers, describe, child, messages, 26 files in checks/), Backend/src/signoff (checkInputs, checks, identity, rules, signoff), Backend/src/logic (canonical, hash, grid, flow, interpreter, schema, index, fill/draftSchema), Backend/validation/compare_outputs.py.
Not covered: logic/fill/resolve.ts internals, steps/extractionSchema.ts body (only compared at a glance), signoff.ts line-by-line (sign-off enforcement is protective and left alone).

Summary: The two "check systems" are LAYERED, not duplicated: src/validation is the pure engine (runChecks + 23 registered checks, all 23 are in DEFAULT_CHECKS, none dead); src/signoff/checks.ts + checkInputs.ts are the I/O wrapper (load version, load inputs, cache findings artifact). The only true dead surface is a small tests-only cluster (validation/checkInputs.ts, the validation/index.ts barrel, snapshotSha/hashableModel), about 150 lines. The real win is PERF: the exact-grid analysis enumerates the grid twice and evaluates each point 5 or more times (plus Q x N more in deadInputs) inside the synchronous save request, and the WeakMap cache never survives a request. Total removable: roughly 150 to 250 lines dead plus a 2 to 4x cut in per-save check CPU.

## Findings

### CHK-01  Grid analysis enumerates the grid twice and evaluates every point 5+ times on each save
- Category: PERF
- Where: src/validation/analysis.ts:90-100 (compute), src/logic/grid.ts:184-188 (analyzeRules), src/validation/checks/severityOrder.ts:130-133, deadInputs.ts:22-35, dangerSignCoverage.ts:125, closedTable/exclusivity via analysis
- Evidence: compute() calls enumerateAnswers(model) (pass 1), then analyzeRules(model) which calls enumerateAnswers again (pass 2). Per grid point it then runs evaluate+allMatches in analyzeRules, evaluate+allMatches again in compute(), evaluate+allMatches a third time in severityOrder.urgentOverlaps, evaluate in dangerSignCoverage (outcomes), evaluate in deadInputs for the baseline, and then deadInputs re-evaluates for every question x every alternative value on every point until a difference is found (a truly dead question costs N x values evaluations). Only boundaryCards uses the shared analysis cleanly. Demo grid is 6400 points; limit is 200000. All of this runs inside the HTTP request: server.ts:225 awaits onVersionSaved -> Signoff.onVersionSaved (signoff.ts:440) -> computeFindings -> runChecks. Grep: enumerateAnswers has only 4 production callers (grid.ts, analysis.ts, flow.ts verifyFlow, compiler/flowMode.ts); no check calls it directly.
- Proposed action: (a) make analyzeRules accept the already enumerated points (or have compute() build the RuleAnalysis from its own loop) so enumeration runs once; (b) store per-point {rule, outcome, severity, matches[]} in Analysis once and let severityOrder, dangerSignCoverage and deadInputs read it instead of calling evaluate/allMatches; (c) in deadInputs only recompute for points where the question was asked, using the stored baseline. Results must stay byte identical (findings ids are hashes), so the existing logicChecks/realPair/redteam1 tests are the safety net.
- Size: about -40 lines of repeated loops; runtime cut roughly 3 to 5x of the check phase on a 6400-point grid
- Risk: CHECK (touches the proof claim "every combination was gone through"; behaviour must be unchanged, do not weaken, only share)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-02  Per-save work that is repeated or sequential: version chain walk, ingest blocks, grid recompute for identical content
- Category: PERF
- Where: src/signoff/checks.ts:188-208 (loadHistory), 246-297 (computeFindings), signoff.ts:440-452 (onVersionSaved)
- Evidence: every save does loadVersion(n) (artifact get + parse + modelSha), then loadHistory walks parent pointers one version at a time with an await per step (artifact get + full parseModel + modelSha for each ancestor), so a run with k versions costs k sequential reads and k parses per save, only to feed openQuestions.ts (the sole reader of ctx.history, openQuestions.ts:27-95). loadCheckContext also re-reads and re-validates ingest/input_blocks.json (the whole booklet text) and extraction_output.json every time. computeFindings always runs the checks even when findingsKey(runId, sha, inputsSha) already exists (ensureFindings has the cache read, onVersionSaved does not use it); a re-save of unchanged content therefore recomputes. WeakMap in analysis.ts and interpreter.ts keys on object identity so nothing is shared between requests.
- Proposed action: (a) fetch the ancestor chain in parallel: store.listVersions already gives all parents, so load the needed versions with Promise.all instead of a serial walk; skip modelSha for ancestors (openQuestions needs only the model); (b) in onVersionSaved, reuse a valid cached record when the key already exists (same content and inputs), as ensureFindings does. Keep verifyLocked and Signoff.sign recomputing every time: that is the sign-off guarantee, do not cache there.
- Size: small code change; saves k-1 serial round trips per save
- Risk: RISKY for (b) if it leaks into sign/verifyLocked (must not); CHECK for (a)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-03  Second model hash (snapshotSha / hashableModel) is tests only and defines a different identity than modelSha
- Category: DEAD
- Where: src/logic/canonical.ts:62-77; tests/logic/canonical.test.ts:2, 85-137
- Evidence: grep -rn "snapshotSha|hashableModel" over src, tests, scripts, compile-demo, pipeline-demo: only canonical.ts and tests/logic/canonical.test.ts use them (compileSnapshot.test.ts:169 is an unrelated object key named snapshotSha). Production identity is modelSha (logic/hash.ts), which excludes only created_at, created_by, change_note and keeps the rest of meta; snapshotSha drops the whole meta. Two functions that sound alike but hash differently is a trap for future callers.
- Proposed action: remove snapshotSha and hashableModel and the matching test blocks (lines 85-137 of the test); canonicalJson stays.
- Size: about 17 lines src + about 55 lines test
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-04  validation/checkInputs.ts and the validation/index.ts barrel have no production caller
- Category: DEAD
- Where: src/validation/checkInputs.ts (31 lines), src/validation/index.ts (39 lines), tests/validation/checkInputs.test.ts (29 lines)
- Evidence: grep for withCheckInputs and loadGoldenCasesFile: definitions plus the barrel re-export plus tests/validation/checkInputs.test.ts only. Its own comment says "Production (src/signoff) should build its context with this", but signoff/checks.ts:259 builds the context inline and signoff/checkInputs.ts (defaultCheckInputs, parseCompileSettings) is the real path. Nothing under src imports "validation/index.js" (grep of `validation/index` and `from "../validation"`: only tests/validation/checkInputs.test.ts). Every src consumer imports specific files (runChecks.js, finding.js, gates.js, context.js).
- Proposed action: delete validation/checkInputs.ts and the barrel; point the one test at runChecks.js directly (or drop the test, it only covers the deleted helper). These are the "two check-input systems": signoff/checkInputs.ts is the live one, this is the stale one.
- Size: about 70 lines src plus 29 test
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-05  Flow rendering helpers (flowToMermaid, describeFlow, describeFlowByOutcome) used only by tests and the demo script
- Category: DEAD
- Where: src/logic/flow.ts:712-823 (regionWords, flowToMermaid, describeFlow, describeFlowByOutcome)
- Evidence: grep over src (excluding flow.ts): 0 hits for all three; regionWords has no outside hit at all. Callers: tests/logic (4, 6 and 3 hits) and compile-demo/flow-outputs.mjs (the generated flow.md/flow.html demo output). Lambda does not need them.
- Proposed action: keep but note: they feed the committed compile-demo flow outputs, so removal depends on whether the demo outputs stay (see CMP area). If the demo is cut, move these 110 lines into the demo script or delete with their tests.
- Size: about 110 lines src plus tests
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-06  Repeated sha256 / canonical-hash boilerplate in four places
- Category: DUP
- Where: src/signoff/checks.ts:99 (sha256 const), src/compiler/compileSnapshot.ts:69 (same const), src/api/server.ts:222 (inline createHash), src/validation/finding.ts:56 (inline), src/logic/hash.ts:15, src/logic/canonical.ts:76
- Evidence: six createHash("sha256")... call sites, three of them `createHash("sha256").update(x).digest("hex")` verbatim.
- Proposed action: one exported `sha256Hex(data)` in logic/canonical.ts (or hash.ts) used by all. Pure refactor; do not change what is hashed (hashes are stored in signatures and finding ids).
- Size: about 10 lines
- Risk: CHECK (hash inputs must be byte identical)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-07  Twin condition-depth and id helpers in logic/schema.ts and fill/draftSchema.ts
- Category: DUP
- Where: src/logic/schema.ts:90-113 (conditionDepth, ID regex, MAX_LIST) versus src/logic/fill/draftSchema.ts:93-106 (depth, Id regex, MAX_LIST)
- Evidence: depth() in draftSchema is the same iterative stack walk as conditionDepth() with a different limit and node shape. Also conditionDepth and MAX_CONDITION_DEPTH have no importer outside schema.ts (grep: 0 in src/tests/demos), so the exported pair is only used internally. The two schemas are otherwise genuinely different (draft names extraction ids, model holds resolved values), so no schema merge is proposed. steps/extractionSchema.ts versus validation/context.ts ExtractionSchema: context.ts is a deliberately loose subset (z.looseObject, only fields the checks read); keep.
- Proposed action: make conditionDepth generic over a child accessor (it already reads "all"/"any" structurally on unknown, so draftSchema can call it directly) and drop draft's depth(); stop exporting MAX_CONDITION_DEPTH/conditionDepth if no one needs them.
- Size: about 15 lines
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-08  Unused or tests-only exports in validation helpers
- Category: DEAD
- Where: src/validation/gates.ts:72 (`_ctx?: CheckContext` parameter), src/validation/analysis.ts (isClosed, DEFAULT_MAX_POINTS exported but only used inside), signoff/checkInputs.ts (DEFAULT_COMPILE_SETTINGS_PATH, goldenCasesKey, compileSettingsKey exported; goldenCasesKey/compileSettingsKey have 2 test hits each), signoff/checks.ts (FindingsRecordSchema, extractionKey, ingestBlocksKey, settingsShaOf exported, used inside file; settingsShaOf also tests), validation/text.ts (quoteTooShort, isPageNumberBlock, wordTokens, hasNegation, matchOnPage, isVerbatim exported; most used only inside text.ts or one check)
- Evidence: grep of each name across src, tests, scripts, compile-demo, pipeline-demo; gates() is called once (runChecks.ts:127) and never passes a second argument that is read. parseCompileSettings has 2 hits outside src/tests (other = compile-demo or pipeline-demo, so keep).
- Proposed action: drop the unused `_ctx` parameter and un-export the symbols with no outside caller. Cosmetic, tiny.
- Size: about 10 lines
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CHK-09  Backend/validation/compare_outputs.py (376 lines) is a standalone two-model comparer outside the TS runtime
- Category: OVER
- Where: Backend/validation/compare_outputs.py (the only tracked file in Backend/validation)
- Evidence: referenced by requirements.txt:5 (a comment) and claude_team/integration.md only; no npm script, Dockerfile, CI or Lambda use. It belongs to the DEC-021/022/023 cross-check experiment.
- Proposed action: decide together with the cross-check folder (see REPO area): keep, or move under cross-check/.
- Size: 376 lines
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

## Looked at and fine
- All 23 checks in src/validation/checks are registered in DEFAULT_CHECKS (runChecks.ts); the other 3 files (common.ts, ageBands.ts, dangerSigns.ts) are shared helpers with live importers. No dead check module.
- The check files are NOT near-identical clones: each has distinct logic. The only repeated pattern is `export const CHECK = "..."` plus a makeFinding call; a generic wrapper would be churn, not savings. common.ts is small and used.
- validation (engine) versus signoff/checks.ts (I/O, cache, gates) is a proper layering; signoff/checkInputs.ts is the only live input provider.
- Findings artifact cache (ensureFindings) is views only; sign and verifyLocked always recompute. That is intentional enforcement. Left alone, including CHECKS_VERSION bumping.
- signoff/identity.ts, rules.ts, signoff.ts: sign-off enforcement (separation of duties, normalised user ids, leases); protective, not bloat.
- getAnalysis WeakMap cache already shares one analysis between the logic checks within a run; interpreter prepare() is cached per model. The waste is in CHK-01, not a missing cache.
- compiler/flowMode prepareFlow and verifyFlow enumerate the grid once each per compile (release path only, not per save).
- logic/schema.ts versus fill/draftSchema.ts versus validation/context.ts ExtractionSchema: different shapes by design (draft refs, resolved model, loose extraction subset).

## Cross-area pointers
- CMP: compile-demo/flow-outputs.mjs and committed flow.md/flow.html decide whether CHK-05 is removable.
- REPO: cross-check/ and claude_team/decisions.md relate to CHK-09.
- CORE: src/api/server.ts:222-227 awaits onVersionSaved (full checks) inside the save request; if CHK-01/02 are not enough, moving checks off the request path is a CORE decision (RISKY: sign-off state transitions depend on it).
- TST: tests/validation/redteam1.mutations.ts, realDraftModel.ts and the two `*.redteam2.test.ts` files overlap with per-check tests; not reviewed here.
