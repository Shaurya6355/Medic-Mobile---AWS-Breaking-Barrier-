# Area 01: CORE (Backend runtime)
Scope: Backend/src/index.ts, config.ts, shutdown.ts, api/, artifacts/, contract/, domain/, engine/, metrics/, model/, steps/ (ingest, extract, fillLogic, checks, validator, extractionSchema), store/, trigger/; Backend/package.json, Dockerfile, .dockerignore as they touch this code. Cross-checked against Infra/lib, Infra/test, AgentService, .github/workflows, Backend/README.md, scripts/, pipeline-demo/, tests/.
Not covered: src/signoff, src/logic, src/validation, src/compiler (areas 02/03); tests content (area 04), only counted where they exist only to cover a removable path. I did not build or measure anything, so size/cold-start numbers are from file sizes and code reading.

Summary: The deployed path (Lambda + Bedrock via Strands, optional AgentCore model backend, `/events` handler, scheduled `resumeAll`) is tight and well commented. The bloat is the two run modes nobody deploys: `RUN_MODE=agentcore` (Backend as an AgentCore runtime; Infra hosts AgentService there, not the Backend) and `RUN_MODE=container` (in-process SQS consumer + resume sweep; no ECS/EC2 stack exists). Together about 330 src lines and about 400 test lines, plus the `@aws-sdk/client-sqs` dependency, are only reachable in those modes. Real runtime wins: sequential per-page S3 reads/writes (up to 200 round trips in extract and in ingest), eager loading of both model backends (Strands 7.9 MB + AgentCore client 2.6 MB) at cold start, and exceljs (22 MB) shipped in the Lambda image although the Lambda never loads the compiler. Engine retry/lease logic is layered but each layer protects something; I recommend leaving it.

## Findings

### CORE-01  RUN_MODE=agentcore (Backend served as an AgentCore runtime) has no deployed host
- Category: DEAD
- Where: Backend/src/api/server.ts:329-367 (the `/invocations` block) plus lines 85-87 (`proxiableRegexes`, `selfPaths`, `DROPPED_HEADERS`) and 54 (`maxInvocationResponseBytes`); src/contract/schemas.ts:100-132 (`INVOCATION_MAX_BODY_BYTES`, `InvocationRequest`, `InvocationResponse`, `PingResponse` busy/time fields); src/contract/routes.ts (`proxiable`, `pattern.invocations`, `invocations()`); src/engine/engine.ts:68-76,102,107 (`activeCount`, `lastStatusChange`, `statusChangedAt`, used only by the `/ping` busy flag); src/api/background.ts non-lambda branch; config.ts `"agentcore"` run-mode value; Dockerfile comments about arm64 AgentCore Runtime.
- Evidence: grep of whole repo for RUN_MODE, `/invocations`, InvocationRequest, resume_all, activeCount, lastStatusChange. Infra sets `RUN_MODE: "lambda"` only (Infra/lib/lambda-stack.ts:84); Infra/lib/agentcore-stack.ts builds the AgentService directory, not Backend; Infra/test/lambda-stack.test.ts:126 asserts `/invocations` is never exposed. The only other `/invocations` in the repo is AgentService's own server (separate contract, `AgentService/src/server.ts:58`). Backend README line 101 says "Nothing here has been run on real AWS". Other users: pipeline-demo/run.ts:113-116 passes `activeCount`/`lastStatusChange` into a port (demo only); tests in tests/contract/agentcore.test.ts and tests/api/server.test.ts (agentcore sections, roughly lines 371-540 and 687+).
- Proposed action: remove the agentcore run mode and its `/invocations` proxy. Keep `/ping` as a plain `{status:"Healthy"}` (the Lambda Web Adapter readiness check at Dockerfile `AWS_LWA_READINESS_CHECK_PATH=/ping` needs it). Do NOT confuse with `MODEL_BACKEND=agentcore` (see Looked at and fine); that one is wired in Infra and stays. If the owner wants AgentCore hosting of the Backend later it can be rebuilt from git history; the code is self-contained.
- Size: about 110 src lines + about 200 test lines (agentcore.test.ts plus the agentcore sections of server.test.ts and background.test.ts)
- Risk: CHECK (documented, tested option; not deployed; nothing on the Lambda path touches it)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-02  RUN_MODE=container (in-process SQS consumer, resume sweep, SIGTERM drain) has no deployed host
- Category: DEAD
- Where: Backend/src/trigger/queueConsumer.ts (88 lines); src/engine/sweep.ts (39); src/index.ts:100-135, 142-159 (AbortController, consumer, `shutdown()`, SIGTERM/SIGINT, startup `resumeAll`, `startResumeSweep`, `resumeSweepIntervalMs`) and `SQSClient` import; src/config.ts (`uploadQueueUrl`, `sqsConcurrency`/SQS_CONCURRENCY, `shutdownTimeoutMs`/SHUTDOWN_TIMEOUT_MS, the container-only REQUIRED rule, the default run mode "container"); src/api/background.ts (23 lines; its only job is the non-lambda "fire and forget" branch); server.ts:308-318 (the non-lambda `/resume` path via `background(orchestrator.resume())`); `Orchestrator.resume()`; `package.json` dependency `@aws-sdk/client-sqs`; Dockerfile `container` target and the shared "runtime" stage comment.
- Evidence: grep for startQueueConsumer, startResumeSweep, SQS_CONCURRENCY, SHUTDOWN_TIMEOUT_MS, UPLOAD_QUEUE_URL across repo: src only in index.ts/config.ts, Infra only passes the queue to an SqsEventSource (lambda-stack.ts:131-140) and Infra/README.md:90 says "UPLOAD_QUEUE_URL not set (not used in lambda mode)". No ECS/EC2/Fargate stack in Infra. `@aws-sdk/client-sqs` imported only by index.ts and queueConsumer.ts. `withDeadline` stays needed (server.ts `/events`), but its injectable timers (`DeadlineTimers`) exist only for shutdown tests. Tests that exist only for these: tests/trigger/queueConsumer.test.ts (192), tests/engine/sweep.test.ts (82), tests/shutdown.test.ts (44, partly), tests/api/background.test.ts (40). `Orchestrator.resume()` is called only from the non-lambda `/resume` branch, pipeline-demo/run.ts:111 and tests. The `/events` Lambda handler in server.ts:374-432 already duplicates the consumer's per-message logic (parseS3Event, de-dupe runIds, onUploaded, redelivery on error), so removing container mode also removes that near-duplicate.
- Proposed action: owner decides if "run the same image anywhere with an SQS queue" is a wanted fallback. If not: delete the files and branches above, make `lambda` the only run mode (drop `runMode` from `ServerDeps`/Config, the `runMode === "lambda"` conditionals, the `RUN_MODE` env, and the default stage), drop `@aws-sdk/client-sqs`. `npm run dev` (tsx watch src/index.ts) currently needs a real queue in container mode, so local dev is not a reason to keep it; the pipeline demo uses in-memory stores instead.
- Size: about 220 src lines + about 350 test lines + 1 dependency (client-sqs about 1 MB in node_modules and the image)
- Risk: CHECK (works today; documented; no deployed consumer). Remove together with CORE-01 so `runMode` can disappear entirely.
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-03  Per-page artifact I/O is sequential (extract reads, ingest writes)
- Category: PERF
- Where: Backend/src/steps/extract.ts:66-74 (`await ctx.artifacts.get(...)` inside `for (const p of doc.pages)`); Backend/src/steps/ingest.ts:164-168 (`await readFile` then `await ctx.artifacts.put(...)` per page).
- Evidence: read both files. Up to MAX_PAGES (default 200) pages, so up to 200 serial S3 GETs in extract and 200 serial S3 PUTs in ingest, each a full network round trip with a PNG body. At roughly 30-80 ms each that is on the order of 6-16 s per step of wall time billed on a 2 GB Lambda, and it eats into the 15 minute invocation budget that already drives the lease and attempt-cap logic. Extract already holds every image in memory at once (the `content` array), so parallel reads add no memory. The model call itself is the long pole, so the gain is seconds per run, not minutes.
- Proposed action: read pages with a bounded pool (for example 8 concurrent, `Promise.all` over chunks, order preserved by index) in extract; upload the page PNGs with the same bounded pool in ingest. Keep the blocks JSON put first as now. The repo already has a `forEachLimited` helper in server.ts that could be moved to a shared util.
- Size: about 20 lines changed, saves seconds per run per step
- Risk: SAFE (pure ordering of independent I/O; the extract content order must be preserved, so collect results by index)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-04  Both model backends (and SQS) load at every cold start
- Category: PERF
- Where: Backend/src/index.ts:5,13,14 (static imports of `./model/agentcore.js`, `./model/strands.js`, `@aws-sdk/client-sqs`).
- Evidence: Lambda runs `node dist/index.js` with MODEL_BACKEND=bedrock (default) or agentcore, never both, and RUN_MODE=lambda never touches SQS. `src/model/strands.ts` imports `@strands-agents/sdk` (7.9 MB on disk) at top level; `src/model/agentcore.ts` imports `@aws-sdk/client-bedrock-agentcore` (2.6 MB); `client-sqs` is 1 MB. ESM static imports evaluate all three before `app.listen`, and the Lambda Web Adapter waits for `/ping` readiness before the first request, so this is paid as init time on every cold start. I did not measure it; the weight is from node_modules sizes and the import graph. In the Lambda with MODEL_BACKEND=agentcore the Strands SDK is loaded for nothing (AgentService is what runs it). exceljs/jszip are NOT loaded by the Lambda (only src/compiler/xlsx.ts imports them; nothing reachable from index.ts imports the compiler index), so no finding there for cold start.
- Proposed action: pick the backend with a dynamic `await import("./model/strands.js")` / `import("./model/agentcore.js")` inside the `modelBackend` branch in `main()`, and drop the SQS import with CORE-02 (or dynamic import it in the container branch). Measure init duration in CloudWatch before and after to confirm the gain is worth it.
- Size: 3 lines changed; init time saving unmeasured (likely hundreds of ms for the Strands SDK)
- Risk: SAFE (the tests mock at the module level; check tsc `module` setting allows dynamic import, it is ESM Node 22)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-05  exceljs and jszip are production dependencies in the Lambda image but only the build-host compiler uses them
- Category: DEP
- Where: Backend/package.json dependencies `exceljs` (22 MB installed), `jszip` (1 MB); used only by Backend/src/compiler/xlsx.ts:10-11.
- Evidence: grep for `exceljs`/`jszip` across src, scripts, pipeline-demo, compile-demo, tests: only xlsx.ts (and compile-demo run.mjs/REPORT text). Dockerfile `deps` stage runs `npm ci --omit=dev`, so both land in the Lambda image. Backend/src/index.ts does not import the compiler; compile is not an API route (comment in index.ts:75-76: "Compile is not here: it runs on the build host (DEC-014), see scripts/compileLocked.ts"). Lambda cold start is unaffected (never loaded), so this is image size only.
- Proposed action: move `exceljs` and `jszip` to devDependencies if every compile entry (`scripts/compileLocked.ts`, `compile-demo`, `pipeline-demo`) is only run from a checkout with a full `npm ci` (it is: they use `tsx`, a devDependency). Owner must confirm no release flow runs compile from the built image. Cross-area: the compiler owner (area 03) and PLT should agree.
- Size: about 23 MB off the runtime image
- Risk: CHECK (if a future in-Lambda compile is planned this reverses)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-06  Test doubles and test-only exports live in src and ship in dist
- Category: OVER
- Where: Backend/src/model/modelClient.ts:62-83 (`FakeModelClient`, `FakeResponse`); src/artifacts/artifactStore.ts:19-48 (`MemoryArtifactStore`; comment says "For tests and local dev only"); src/steps/logicModelValidator.ts:21-26 (`acceptAnyObjectValidator`); src/contract/schemas.ts:145-155 (`LambdaSqsEvent`, `LambdaEvent` and their types); src/contract/routes.ts:28-50 (the `routes.runs()/run()/versions()...` builder functions).
- Evidence: grep across repo. `FakeModelClient`: tests only (pipeline, hardening, fillLogic tests). `acceptAnyObjectValidator`: tests only (server.test.ts, fillLogic.test.ts). `LambdaSqsEvent`/`LambdaEvent`: used only by tests/contract/lambda.test.ts; server.ts uses `LambdaSqsEnvelope` + `LambdaSqsRecord` (per-record validation). `routes.*()` builders: used only by tests (routes.test.ts, pipeline.test.ts, signoff.test.ts) and nothing in src (server uses `routes.pattern`). `MemoryArtifactStore`: tests plus scripts/fillLive.ts and pipeline-demo/run.ts (demos), so it has real non-test users; MemoryStore likewise (intentional parallel, left alone).
- Proposed action: move `FakeModelClient`, `acceptAnyObjectValidator` and the `routes` builder functions into tests/helpers (or delete the builders and inline the strings in tests); delete `LambdaSqsEvent`/`LambdaEvent` and their schema test. Keep `MemoryArtifactStore` where it is (demos use it). Low value on its own; do it only when touching these files anyway.
- Size: about 60 lines out of dist
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-07  Scans: resume sweep and GET /runs read the whole runs table
- Category: PERF
- Where: Backend/src/store/dynamoStore.ts:103-112, 145-148, 493-507 (`scanAll`, `listRuns`, `listResumable`); server.ts:151-154.
- Evidence: `listResumable` runs on every scheduled sweep (every 5 minutes in Lambda, Infra/lib/lambda-stack.ts:145) plus once per container start; it is a ConsistentRead Scan with a FilterExpression, which bills the full table read, not just the matching items. `GET /runs` scans the same table and returns every run unpaginated (including `pages` arrays and lease maps). Cost grows with total runs ever created, and runs are never deleted (locked and failed runs stay). The Infra comment (data-stack.ts:138) documents Scan as intended. At pilot volume (tens of runs) this is negligible.
- Proposed action: keep for now. When run count reaches the hundreds, add a sparse GSI (for example partition key `workState` set only while a run is in a work state) so the sweep becomes a Query, and paginate `GET /runs`. Do not do it speculatively.
- Size: n/a now; noted for the owner
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-08  Two attempt limits plus an attempt floor (retry, cap, reset) do overlapping work
- Category: OVER
- Where: Backend/src/engine/runner.ts (`maxAttempts`, backoff); engine.ts:14-16,131-156,189-198,219-236 (`DEFAULT_MAX_TOTAL_ATTEMPTS`, `remaining`, `attemptFloor`, `failCapped`); domain/types.ts:9 (`attemptFloor`); index.ts:67-72.
- Evidence: runner retries a transient failure up to 3 times in one invocation with 1-30 s backoff. The engine separately caps total attempts per step at 6 across invocations (counting `abandoned` ones left by a Lambda that hit its 15 minute limit), and `prepareResume` writes an `attemptFloor` on the run so a manual resume restarts the budget. Further layers around it: SQS redelivery (maxReceiveCount 5, DLQ), the 5 minute scheduled sweep, and the lease. The cap and floor are the only guard against a step that keeps outliving its invocation being retried and paid for forever (comment engine.ts:14), and the floor is what makes "resume the run" work after a cap failure, so each layer has a distinct failure it covers.
- Proposed action: keep but note. This is protective cost control, not duplication of the same mechanism. Only simplification worth considering is dropping `maxTotalAttempts` as a constructor option (nothing but tests passes it).
- Size: about 5 lines if the option is dropped
- Risk: RISKY (touches resume and lease semantics; correctness/cost protection)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### CORE-09  Small redundant reads and a parameter with only demo callers
- Category: PERF
- Where: Backend/src/engine/engine.ts:92-97 (`onUploaded(runId, docSha256?)`), 112-116, 131; Backend/src/store/dynamoStore.ts addSignature/rejectVersion trailing `getVersion`.
- Evidence: `onUploaded` does `getRun`, then `advance` -> `advanceHeld` does `acquireLease` and a second `getRun`; the step loop does `listSteps` (a full Query of all steps of the run) once per step plus `acquireLease` before and after each step. That is about 3 extra DynamoDB calls per step over 4 steps; each is a single-digit-ms call against a run that lasts minutes, so the saving is negligible. `docSha256` parameter: only pipeline-demo/run.ts:171 and tests pass it; the real path sets it in ingest.ts:140-143 itself. The trailing `getVersion` after a signature is needed to return the new state (TransactWrite returns nothing).
- Proposed action: leave the reads. Optionally drop the `docSha256` parameter of `onUploaded` and have the demo set it through the store.
- Size: about 3 lines
- Risk: SAFE
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

## Looked at and fine
- `MODEL_BACKEND=agentcore` (src/model/agentcore.ts, agentcoreWire.ts, `@aws-sdk/client-bedrock-agentcore`): wired in Infra (lambda-stack.ts:94-99 sets MODEL_BACKEND and the invoke policy; agentcore-stack.ts hosts AgentService; Infra/test/agentcore-stack.test.ts covers it) and AgentService/tests/wireDrift.test.ts imports `toWireContent`. Intentional optional path, keep. The duplicated transient-error classifiers in strands.ts and agentcore.ts differ in their name sets and the agentcore one handles `RuntimeClientError`; AgentService has its own `isTransientBedrockError` copy (cross-package, not shareable without a package). Not worth merging.
- memoryStore.ts vs dynamoStore.ts: intentionally parallel; MemoryStore is used by pipeline-demo and scripts/fillLive.ts besides tests.
- `/events` handler (server.ts:369-433) and its `forEachLimited`, the per-record validation, partial batch failures, 14 minute deadline: this is the deployed path, keep. `batchSize: 1` in Infra means the concurrency option rarely matters, but the contract allows up to 100 records and the code is small.
- `/resume` lambda branch + `prepareResume`: deployed path.
- Lease (`acquireLease`/`releaseLease`), `active` set, conditional writes, transactional addVersion/addSignature/rejectVersion, audit append-only keys: sign-off and concurrency enforcement, do not simplify.
- `shutdown.ts withDeadline`: still needed by `/events` and the scheduled sweep after CORE-02; its injectable timers are test-only but 5 lines.
- Config options with real deployed or tested use: LEASE_MS (Lambda must exceed 900000), PRICES_JSON (Infra passes it), MAX_PAGES, MAX_PDF_BYTES (guards ingest download size), FILL_MODEL_ID/FILL_PROMPT/EXTRACT_PROMPT/INGEST_SCRIPT/PYTHON_BIN (override points with sane defaults, documented in README; unset in Infra, tiny, keep). `HOST`/`PORT` are used by the adapter port.
- Version bodies are written with `JSON.stringify(x, null, 2)` and `bodySha256` is computed over those exact bytes (DEC-020); do not minify. The pretty-printed `input_blocks.json`/extraction output are read once, not worth changing.
- Dockerfile three-stage layout (build, deps, runtime) and the files copied (extraction/prepare_input.py, final_prompt.txt, fill_prompt.txt, package.json for `"type":"module"`) are all needed by the Lambda. `.dockerignore` is correct.
- `docSha256`, `currentStep`, `attemptFloor` fields on Run: all have live readers (fillLogic, resume, engine).
- `store.listAudit`: tests and pipeline-demo only, but it is the read side of the audit trail; keep.
- Per-step DynamoDB call count in engine/runner (start, end, three audit puts per attempt): audit trail by design.

## Cross-area pointers
- Area 04 (TESTS): tests/trigger/queueConsumer.test.ts, tests/engine/sweep.test.ts, tests/shutdown.test.ts, tests/api/background.test.ts, tests/contract/agentcore.test.ts and the agentcore/container sections of tests/api/server.test.ts and tests/config.test.ts go away with CORE-01/02; tests/contract/lambda.test.ts `LambdaSqsEvent`/`LambdaEvent` cases go with CORE-06.
- Area 06 (PLATFORM): Dockerfile `container` target and the "arm64 AgentCore Runtime" comment (CORE-01/02); CI jobs that build or test those modes; CORE-05 exceljs/jszip move needs the build-host install story confirmed; Infra/README.md lines 90 and 126 already state container-mode vars are unused.
- Area 05 (REPO): Backend/README.md sections "Running on AgentCore" (lines ~99-107), the RUN_MODE/UPLOAD_QUEUE_URL/SQS rows and shutdown paragraph (lines ~59-62, 85) shrink with CORE-01/02.
- Area 03 (COMPILE): `src/compiler/index.ts` re-exports xlsx.ts; nothing in the Lambda path imports it, so exceljs is only an image-size issue (CORE-05).
