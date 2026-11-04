# Orchestrator

Backend service that takes an uploaded clinical guideline PDF through a fixed flow (ingest, extract, fill logic, automatic checks), then through sign-off (program officer, then clinician, then lock; DEC-019), stores every run, step, version, comment and audit event in DynamoDB and S3, and exposes an HTTP API for the UI to create runs, save edited versions, comment and resume. Uploads are detected through an S3 event notification delivered to SQS.

## Develop

```
npm ci
npm test              # vitest run
npx tsc --noEmit      # typecheck
npm run build         # emits dist/ (tests excluded)
npm start             # node dist/index.js
npm run dev           # tsx watch src/index.ts
npm run compile:demo  # logic model fixture -> CHT project -> real cht-conf (see compile-demo/README.md)
npm run pipeline:demo # whole chain with sign-off rules, in memory, FakeModelClient (see "Sign-off" below)
npm run compile:locked -- --run <id> --version <n> --settings <file> [--out <dir>]  # compile job (DynamoDB + S3)
```

## Sign-off (src/signoff, DEC-019)

Humans approve; code enforces BRD AR-01 to AR-10. Run states after fill_logic: `checking` (the `checks` step runs `runChecks` and stores the findings) -> `awaiting_officer` -> `awaiting_clinician` -> `locked`. Every version saved through the API goes back through `checking` to `awaiting_officer` (from any review state, `locked` included), via `onVersionSaved`.

- Findings: one artifact per content, `runs/<id>/checks/<modelSha>.json`, with every finding, the gates and the plain-language view per audience (`findingsFor`). Computed again on demand when missing, so a crash between save and check never lets a version be signed unchecked.
- Signature record `{runId, n, modelSha, role, userId, signedAt}` appended to the version item by `Store.addSignature`, an atomic conditional write (DynamoDB: a transaction with a ConditionCheck that the version is still the latest). The request names the `modelSha` the signer reviewed; any other sha is refused.
- Rules: officer first, clinician second (409 `officer_signature_required`); two different people (403 `separation_of_duties`); refused while the role's gate has blocking findings (422 `blocked`, with the blockers in plain words; officer: officer-owned blockers, clinician: clinical blockers including open questions routed to the clinician; an open question is settled by marking it resolved with a written resolution in a new version); only the latest version can be signed (409 `superseded`); a locked version takes no signature (409 `locked`); role in the body must match the endpoint (403 `role_mismatch`). Both signatures on the same sha set `status: "locked"`; a later save is a new version with zero signatures and the locked one stays the releasable one (`latestLocked` in the status view, AR-09).
- AUTH SEAM: `role` and `userId` come from the request body until Cognito is built (DEC-015). Separation of duties therefore holds only against honest callers for now.
- Compile guard: `compileSnapshot` with `buildKind: "release"` needs `approval: { snapshotSha, version }` and re-checks the lock evidence (`verifyLock`); `compileLockedVersion` (src/compiler/compileLocked.ts) reads it from the store. Preview builds stay unguarded and are stamped "not approved, not deployable".
- Compile is NOT a Lambda step (DEC-014). `scripts/compileLocked.ts` is the job for the build host (EC2, not built): it refuses an unlocked version before touching its output folder, builds the release project, runs cht-conf through `compile-demo/chtConf.ts` (shared with compile:demo) and stores the manifest and cht-conf outputs under `runs/<id>/compile/<modelSha>/`. Exit codes 0 pass, 2 usage, 3 refused, 4 cht-conf failed, 5 cht-conf not installed.
- `npm run pipeline:demo` runs the whole chain with the in-memory store and writes `pipeline-demo/output/` (TRACE.md, findings, summary, the locked version and the compiled project). Its edits come from `tests/helpers/resolveForDemo.ts`, which is TEST-ONLY: its answers to the open questions are placeholders, not clinical decisions. Without `compile-demo/tools` installed the cht-conf part is skipped with a message.

## CHT compiler (src/compiler)

`compileSnapshot(model, { projectDir, buildKind, settings, approval?, flowLimits? })` turns a parsed logic model (v1.json shape, DEC-017) into a CHT project directory that cht-conf compiles: `forms/app/<pathway_id>.xlsx` and `.properties.json`, `tasks.js` (scheduled follow-ups only), `targets.js`, `contact-summary.templated.js`, `app_settings/base_settings.json`, `.eslintrc`, `translations/messages-en.properties`, `sourcemap.json` and a README. It returns a manifest (file sha256s, formId, modelSha, buildKind, warnings, notCompiled, flow, sourcemap) and refuses with a `CompileError` (`result.compile_ready === false`, every missing field listed) when something it needs is absent. Compiler settings (form title, icon, team default task window, contact types, flowMode) are a separate settings JSON, not part of the model or of modelSha. Static project files are in `src/compiler/template/` (copied to `dist/` by `npm run build`). `npm run compile:demo` runs the real cht-conf 6.6.1 against the output; it is not part of `npm test`.

### Question flow (which questions the form asks)

The form shows one question per screen. By default it asks only the questions whose answer can still change the outcome. `deriveFlow` (src/logic/flow.ts) works this out from the rule table at compile time. The flow is not part of the signed model. It is a deterministic artefact: anyone can rebuild it from modelSha, the flow mode and `FLOW_DERIVATION_VERSION` (currently `flow-2-is_no`). Its conditions use a flow-only type, `FlowCondition`. This type has the model's atoms plus `is_no`, which is true only when the answer is no; a blank answer never counts as no. It also has the constant `"never"`. The model's own condition vocabulary (is_yes, at_least, less_than, all, any) is unchanged. The compiler emits `is_no` as `${f} = 'no'` (never `not()`) and `"never"` as `false()`. Each question row and its page group get the authored shown_when AND the flow condition, so a skipped question's screen disappears.

`settings.flowMode` picks the flow, and the clinician chooses it:

- `minimal` (default): only the questions that can still change the outcome. On the v1 grid this averages 3.19 questions instead of 8.92.
- `danger_signs_always`: like minimal, but every danger-sign question is always asked (8.20).
- `full`: the authored shown_when only, as before (8.92).

The minimal flow never asks danger-sign questions of a child outside 2 to 59 months, because the outcome is already decided. For example, a 1-month-old with convulsions is referred without anyone asking about convulsions. That is the Q2 hazard, and minimal makes it silent. `danger_signs_always` exists for this reason.

Before emitting, `compileSnapshot` runs `verifyFlow` on every point of the exact answer grid. The short form must give the same outcome as answering every question. Any mismatch is refused with a `CompileError`, and so is a flow too large to derive (`flowLimits`). The manifest (`flow`), the project README and `sourcemap.json` record flowMode, the derivation version, the flow stats and the average question counts. The sourcemap marks question rows that carry a flow condition with `flowCondition`. The saved answer of a skipped question is blank.

## Environment variables

| Name | Required / default | Purpose |
| --- | --- | --- |
| TABLE_RUNS | required | DynamoDB table for runs |
| TABLE_STEPS | required | DynamoDB table for step records |
| TABLE_VERSIONS | required | DynamoDB table for logic model versions |
| TABLE_COMMENTS | required | DynamoDB table for comments |
| TABLE_AUDIT | required | DynamoDB table for the audit log |
| ARTIFACT_BUCKET | required | S3 bucket for uploads and step artifacts |
| RUN_MODE | container | `container` (SQS consumer and resume sweep run in-process), `agentcore` (see Running on AgentCore) or `lambda` (see Running on Lambda; LEASE_MS defaults to 960000 and must exceed 900000 there; the Docker `lambda` target sets it). Any other value fails startup |
| MODEL_BACKEND | bedrock | `bedrock` (Strands in this process) or `agentcore` (see Model backend). Any other value fails startup |
| AGENTCORE_RUNTIME_ARN | required when MODEL_BACKEND=agentcore | ARN of the AgentCore Runtime running the AgentService (service `bedrock-agentcore`); ignored otherwise |
| UPLOAD_QUEUE_URL | required when RUN_MODE=container (not used by agentcore or lambda) | SQS queue receiving S3 ObjectCreated notifications |
| MODEL_ID | required | Bedrock inference profile ID (us. prefix) |
| AWS_REGION | us-west-2 | AWS region for all clients |
| PORT | 8080 | HTTP port |
| HOST | 0.0.0.0 | HTTP bind address |
| LEASE_MS | 900000 | Run lease duration; must exceed the longest single step |
| MAX_PAGES | 200 | Maximum page number accepted when creating a run, and the largest page count (`pdfinfo`, whole document) ingest will render |
| MAX_PDF_BYTES | 52428800 | Largest input PDF ingest will download (S3 HeadObject size check before the download); over it the step fails permanently |
| SQS_CONCURRENCY | 4 | Messages processed in parallel |
| SHUTDOWN_TIMEOUT_MS | 25000 | On SIGTERM/SIGINT, how long to wait for in-flight upload handling before closing the server and exiting 0 |
| PYTHON_BIN | python3 | Python executable for ingest |
| INGEST_SCRIPT | extraction/prepare_input.py next to the build | Ingest script path |
| EXTRACT_PROMPT | extraction/final_prompt.txt next to the build | Extraction system prompt path |
| FILL_PROMPT | extraction/fill_prompt.txt next to the build | fill_logic (draft) system prompt path |
| FILL_MODEL_ID | MODEL_ID | Bedrock model for the fill_logic draft. Infra grants Bedrock access to MODEL_ID only, so a different value also needs the IAM policy widened |
| GOLDEN_CASES_PATH | tests/fixtures/logic/golden-proposed.json (proposed, awaiting Medic; TODO DEC-020) | Golden cases for the checks when the run has no `runs/<id>/inputs/golden_cases.json`. `none` switches them off; a set path that is missing is an error. Missing default (Lambda image): the findings say the test-case check did not run |
| COMPILE_SETTINGS_PATH | compile-demo/settings.demo.json (TODO DEC-020) | Compile settings for the checks when the run has no `runs/<id>/inputs/compile_settings.json`. Their sha256 is recorded on each signature; a release build must use the same settings |
| PRICES_JSON | none | JSON map of model ID to `{inPerMTok, outPerMTok}` for cost metrics |

Startup fails with a list of the names of any missing required variables.

## Shutdown

On SIGTERM or SIGINT the process stops polling SQS and the resume sweep, waits up to `SHUTDOWN_TIMEOUT_MS` for in-flight upload handling to finish, closes the HTTP server (waiting at most 5 s) and exits 0 even if work is still running. A pipeline cut off this way keeps its lease; the periodic resume sweep of a later process resumes it once the lease has expired (up to `LEASE_MS` later). Set the container stop grace period above `SHUTDOWN_TIMEOUT_MS` plus 5 s.

## HTTP API

Route names and request/response shapes are defined only in `src/contract/` (`routes.ts`, `schemas.ts`). The API covers creating a run (returning a presigned upload URL), reading a run, saving versions, comments, resuming a run, and sign-off: `GET .../versions/:n/findings[?audience=program_officer|clinician]`, `GET .../versions/:n/status`, `POST .../versions/:n/signatures/:role` with body `{role, userId, modelSha}` (201, or 400/403/404/409/422 as listed under "Sign-off"). See that folder for the exact paths.

## Docker

`docker build -t orchestrator .` from this folder. The Dockerfile is written to install `poppler-utils` and `python3` for ingest, to run as the non-root `node` user and to copy no credentials into the image; supply AWS credentials through the runtime (for example an instance or task role). The image has not been built or scanned, so none of this has been verified.

## Model backend

`MODEL_BACKEND=bedrock` (default) runs the Strands agent call in this process against Amazon Bedrock. `MODEL_BACKEND=agentcore` sends it to an AgentCore Runtime hosting the AgentService instead, via `InvokeAgentRuntime` (`src/model/agentcore.ts`). `MODEL_ID` is still the model id, and is passed to the agent service in the request. The wire contract (`src/model/agentcoreWire.ts`) must match `AgentService/src/contract.ts`. Each call uses a fresh random runtime session id and a 6 minute timeout (constructor option `timeoutMs`; the Bedrock path has the same default, implemented with the Strands `cancelSignal` plus a non-cancelling `Promise.race` backstop). AgentCore turns a container 4xx/5xx into an opaque `RuntimeClientError` (HTTP 424), so the AgentService always answers HTTP 200 with an envelope: `{ok:true, raw, usage}` or `{ok:false, kind:"transient"|"permanent"|"invalid_request", message}`. `transient` becomes a retryable `TransientError`; the other kinds are plain permanent errors. A `RuntimeClientError` whose message matches `Received error (429|5xx)`, any error or response `statusCode` of 429/5xx, throttling, quota, retryable conflict, timeouts and network errors also become `TransientError`s; validation, access denied, not found and other 4xx are permanent. The wire limits (at most 700 content blocks, derived from 3 blocks per page plus 2 for the default 200 pages; at most 90 MiB of JSON, below AgentCore's 100 MB payload cap) are mirrored in `agentcoreWire.ts` and checked before sending, so an oversized extract fails with a clear permanent message instead of a round trip. The drift test in `AgentService/tests/wireDrift.test.ts` imports `agentcoreWire.ts`, so the CI `agentservice` job must run `npm ci` in `Backend` as well as in `AgentService`. A model answer that is not valid JSON for the step still records the usage of the call. The orchestrator's IAM role needs `bedrock-agentcore:InvokeAgentRuntime` on the runtime. The AgentCore path is unverified on real AWS: tests use a mocked SDK client.

## Running on AgentCore

The same image can run as an Amazon Bedrock AgentCore Runtime agent (HTTP protocol contract) by setting `RUN_MODE=agentcore` (`/invocations` exists only in this mode). Nothing here has been run on real AWS.

- The server listens on `0.0.0.0:8080`. The image must be ARM64: `docker buildx build --platform linux/arm64 -t orchestrator .`
- `GET /ping` returns `{status: "Healthy"}` when this process is advancing no run and `{status: "HealthyBusy"}` while it is, so a busy session is kept alive. `time_of_last_update` (unix seconds) changes only when the status changes, not on each ping.
- `POST /invocations` takes a JSON body validated against `InvocationRequest` in `src/contract/schemas.ts`: `{action:"uploaded", runId}` and `{action:"resume_all"}` run in the background and answer 202 `{accepted:true}`; `{action:"http", method, path, headers?, body?}` replays the request against the normal API in-process and answers `{statusCode, headers: {content-type}, body}`. Only the API routes in the contract are reachable that way: `/ping` and `/invocations` are refused and responses over 1 MiB give 502.
- In this mode `UPLOAD_QUEUE_URL` is not required, and the SQS consumer, the startup resume and the periodic resume sweep are not started. Something outside the process (for example a Lambda fed by the upload queue, calling the runtime with SigV4) must invoke `uploaded` and, periodically, `resume_all`.
- Sessions can be stopped when idle. A run cut off that way keeps its lease and is picked up by a later `resume_all` once the lease expires. The in-process active set stops one process advancing a run twice at once, and the DynamoDB lease stops two sessions advancing the same run at once, so duplicate invocations across sessions do not duplicate work.
- Like the container mode, the API has no authentication of its own; access control is the SigV4 invocation of the runtime.

## Running on Lambda

The same image runs as an AWS Lambda container image with `RUN_MODE=lambda`, using the AWS Lambda Web Adapter (extension at `/opt/extensions/lambda-adapter`). Build it with `docker build --target lambda .` (the Dockerfile's last stage is `container`, so a plain `docker build .` still gives the container image). The `lambda` target sets `AWS_LWA_PORT=8080`, `AWS_LWA_READINESS_CHECK_PATH=/ping`, `AWS_LWA_PASS_THROUGH_PATH=/events`, `AWS_LWA_ERROR_STATUS_CODES=500-599` (so a 5xx answer to a non-HTTP event makes Lambda retry it) and `RUN_MODE=lambda`. Nothing here has been run on real AWS, and the Docker build of this target has not been verified (no Docker daemon was available); only the adapter tag `public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1` was confirmed to exist.

- API Gateway HTTP events reach the Fastify routes as ordinary HTTP. Non-HTTP events (SQS, EventBridge schedule) are forwarded by the adapter as `POST /events`, a route registered only when `RUN_MODE=lambda` (404 in other modes).
- SQS event source: enable `ReportBatchItemFailures`. Each record body is parsed as an S3 notification; every uploaded input is advanced to completion before the response. A record whose handling throws is returned in `batchItemFailures` and redelivered; unparseable or irrelevant records are consumed. Batch size up to 100 is accepted (Lambda default 10).
- A scheduled event (EventBridge rule, `source: aws.events`) runs `resumeAll`. There is no startup resume and no in-process sweep in lambda mode, so this schedule IS the recovery mechanism after a hard cut.
- Lambda freezes the process after the response, so in lambda mode `POST /runs/{id}/resume` does only the quick `failed` -> step-state transition (`Orchestrator.prepareResume`, which also gives the step a fresh attempt budget) and answers 202 at once; it does not run the pipeline. The run is then in a work state with no lease, so `listResumable` returns it and the scheduled sweep (at most one schedule period later, 5 minutes in the default stack) advances it. `/invocations` is registered only when `RUN_MODE=agentcore` (404 otherwise); `/ping` exists in every mode. `/events` has one overall 14 minute deadline per batch, and the scheduled `resumeAll` has the same 14 minute deadline: records or runs unfinished at that point are returned in `batchItemFailures` or left for the next sweep. A record for an unknown run is consumed, and one malformed or oversized record does not reject the batch. Container and agentcore behaviour is unchanged.
- The partial-batch reply key is `batchItemFailures` (checked against `SQSBatchResponse` from `@types/aws-lambda` in `tests/contract/lambda.test.ts`); a different key makes Lambda treat the whole batch as successful.
- Work that is still running after the 14 minute deadline is not cancelled: Lambda freezes it when the response is sent and it may thaw in a later invocation of the same container, stale. The lease owner checks stop a stale run from transitioning a run another owner has taken over, but it can still write an attempt record or artifact; those writes are idempotent and are superseded by the new owner's attempt.
- Lambda allows at most 15 minutes per invocation. The engine's steps are idempotent and a lease that expires lets the next invocation resume the run. In lambda mode `LEASE_MS` defaults to 960000 and any explicit value of 900000 or less fails startup; keep it above the function timeout so a live invocation is never taken over; after a hard cut the run is picked up by the scheduled sweep once the lease expires.

Security: there is no authentication on the API yet. `/events` must not be reachable from the internet: the API Gateway integration must expose only the explicit contract routes (`/runs...`) and never `/events`; `/invocations` must not be exposed either. Do not use a greedy `{proxy+}` route to the function.

## Attempt cap, timeouts and input bounds

- Each step may use at most 6 attempts in total (`DEFAULT_MAX_TOTAL_ATTEMPTS`, option `maxTotalAttempts` on the Orchestrator), counting attempts abandoned by an invocation that was cut off. Past the cap the step fails with an `Attempt cap reached` message instead of being retried, so a document that always outlives the invocation cannot loop and be billed forever. A manual resume starts a fresh budget for that step (`attemptFloor` on the run).
- Ingest refuses an input PDF over `MAX_PDF_BYTES` (checked with a size lookup through `ArtifactStore.size`, before downloading) and one with more than `MAX_PAGES` pages (`pdfinfo` from poppler, before `pdftoppm` renders anything). Both fail the step permanently with a clear message. The page limit applies to the whole document even when `pages` selects a few, because the whole document is rendered.
- Not done: the proper upload cap is a presigned POST with a `content-length-range` condition. It is deferred because it changes the create-run response contract (a URL plus form fields instead of a plain PUT URL). Until then a presigned PUT can upload a larger object; ingest refuses it before use, but it is still stored.

## CI

`.github/workflows/ci.yml` runs on push and pull_request with read-only permissions: backend typecheck, tests and build, Infra typecheck, tests and `cdk synth` (dummy account, no credentials), and a Docker build of the image for linux/amd64 and linux/arm64 without pushing. CI runs tests only; deploys are manual.

## Not verified / known gaps

- Nothing has run against real DynamoDB, S3, SQS or Bedrock. Unit tests use in-memory stores and mocked AWS clients.
- The DynamoStore contract suite runs only when `DYNAMODB_ENDPOINT` is set.
- The Docker image was not built: the Docker daemon was not running when this was written.
- The API has NO authentication. Do not expose it publicly.
- Hosting is undecided. Project rules say EC2 containers; the team prefers Strands on AgentCore. See `docs/superpowers/specs/2026-11-03-orchestrator-design.md` (OI-6, OI-7).
- The lease can lapse during a single very long step, so `LEASE_MS` must exceed the longest step.
- Ingest kills `prepare_input.py` after 5 minutes (`DEFAULT_EXEC_TIMEOUT_MS` in `src/steps/ingest.ts`; pass `createDefaultExec({ timeoutMs })` to change it). A very long PDF can exceed this; the step then fails non-transiently.
- Version bodies (the fill_logic draft and versions saved through the API) are validated with `parseModelValidator` (the logic model schema, `src/logic/schema.ts`); the checks run after fill_logic (`checks` step) and on every save (`onVersionSaved`, synchronously inside the save request).
- Sign-off has no real identity yet (DEC-015): role and user are taken from the request body. Reject (BR-17, AR-06), urgent marking (RR-02), release to IT and the single-editor lock (BR-10) are not built.
- fill_logic: the model returns a draft that names extraction items by id and thresholds by index (`src/logic/fill/draftSchema.ts`); `src/logic/fill/resolve.ts` writes every number, operator, quote and the meta, adds the out-of-age-range and catch-all rules (origin team) and lists team choices and every unclear item as open questions. Draft problems get one repair call, then the step fails. The live Bedrock run (`npm run fill:live`, needs AWS credentials) has not been run.
- The upload queue MUST have a redrive policy with a dead-letter queue and a `maxReceiveCount` (suggested: 5). This is infrastructure the IaC must create; this repo does not. When `onUploaded` throws, the consumer leaves the message on the queue so SQS redelivers it, and without a dead-letter queue a poison message is redelivered forever. A poison message looks like a message that keeps reappearing with the same run ID in the "onUploaded failed" log, for example a stray `runs/<id>/input/guideline.pdf` upload for a run that does not exist, or an event that arrives before the run row is written.
- A run stuck in `created` (its upload event failed every delivery and went to the dead-letter queue) has no automatic recovery: the resume sweep does not start runs in `created`. Replay the upload event, for example by redriving it from the dead-letter queue, once the cause is fixed.
- The SQS visibility timeout (default 900 s here) and `LEASE_MS` must BOTH exceed the longest single step. Redelivery of a message whose run is already running or finished is harmless, because the engine ignores a start for a run that is no longer `created`.
- If the process is killed mid-run (SIGKILL), the run keeps the dead process's lease until it expires. Every process runs `resumeAll` once at startup and then on a periodic resume sweep every `min(60 s, LEASE_MS / 2)`; the sweep picks the run up once the dead owner's lease has expired, so recovery can take up to `LEASE_MS` (plus one sweep interval) after the kill. Succeeded steps are not re-run; the interrupted step's running record is marked abandoned and the step runs again.
