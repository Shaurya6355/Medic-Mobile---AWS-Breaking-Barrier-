# Orchestrator

Backend service that takes an uploaded clinical guideline PDF through a fixed flow (ingest, extract, fill logic), stores every run, step, version, comment and audit event in DynamoDB and S3, and exposes an HTTP API for the UI to create runs, save edited versions, comment and resume. Uploads are detected through an S3 event notification delivered to SQS.

## Develop

```
npm ci
npm test              # vitest run
npx tsc --noEmit      # typecheck
npm run build         # emits dist/ (tests excluded)
npm start             # node dist/index.js
npm run dev           # tsx watch src/index.ts
```

## Environment variables

| Name | Required / default | Purpose |
| --- | --- | --- |
| TABLE_RUNS | required | DynamoDB table for runs |
| TABLE_STEPS | required | DynamoDB table for step records |
| TABLE_VERSIONS | required | DynamoDB table for logic model versions |
| TABLE_COMMENTS | required | DynamoDB table for comments |
| TABLE_AUDIT | required | DynamoDB table for the audit log |
| ARTIFACT_BUCKET | required | S3 bucket for uploads and step artifacts |
| UPLOAD_QUEUE_URL | required | SQS queue receiving S3 ObjectCreated notifications |
| MODEL_ID | required | Bedrock inference profile ID (us. prefix) |
| AWS_REGION | us-west-2 | AWS region for all clients |
| PORT | 8080 | HTTP port |
| HOST | 0.0.0.0 | HTTP bind address |
| LEASE_MS | 900000 | Run lease duration; must exceed the longest single step |
| MAX_PAGES | 200 | Maximum page number accepted when creating a run |
| SQS_CONCURRENCY | 4 | Messages processed in parallel |
| SHUTDOWN_TIMEOUT_MS | 25000 | On SIGTERM/SIGINT, how long to wait for in-flight upload handling before closing the server and exiting 0 |
| PYTHON_BIN | python3 | Python executable for ingest |
| INGEST_SCRIPT | extraction/prepare_input.py next to the build | Ingest script path |
| EXTRACT_PROMPT | extraction/final_prompt.txt next to the build | Extraction system prompt path |
| PRICES_JSON | none | JSON map of model ID to `{inPerMTok, outPerMTok}` for cost metrics |

Startup fails with a list of the names of any missing required variables.

## Shutdown

On SIGTERM or SIGINT the process stops polling SQS and the resume sweep, waits up to `SHUTDOWN_TIMEOUT_MS` for in-flight upload handling to finish, closes the HTTP server (waiting at most 5 s) and exits 0 even if work is still running. A pipeline cut off this way keeps its lease; the periodic resume sweep of a later process resumes it once the lease has expired (up to `LEASE_MS` later). Set the container stop grace period above `SHUTDOWN_TIMEOUT_MS` plus 5 s.

## HTTP API

Route names and request/response shapes are defined only in `src/contract/` (`routes.ts`, `schemas.ts`). The API covers creating a run (returning a presigned upload URL), reading a run, saving versions, comments, and resuming a run. See that folder for the exact paths.

## Docker

`docker build -t orchestrator .` from this folder. The image installs `poppler-utils` and `python3` for ingest, runs as the non-root `node` user and contains no credentials; supply AWS credentials through the runtime (for example an instance or task role).

## Not verified / known gaps

- Nothing has run against real DynamoDB, S3, SQS or Bedrock. Unit tests use in-memory stores and mocked AWS clients.
- The DynamoStore contract suite runs only when `DYNAMODB_ENDPOINT` is set.
- The Docker image was not built: the Docker daemon was not running when this was written.
- The API has NO authentication. Do not expose it publicly.
- Hosting is undecided. Project rules say EC2 containers; the team prefers Strands on AgentCore. See `docs/superpowers/specs/2026-11-03-orchestrator-design.md` (OI-6, OI-7).
- The lease can lapse during a single very long step, so `LEASE_MS` must exceed the longest step.
- Ingest kills `prepare_input.py` after 5 minutes (`DEFAULT_EXEC_TIMEOUT_MS` in `src/steps/ingest.ts`; pass `createDefaultExec({ timeoutMs })` to change it). A very long PDF can exceed this; the step then fails non-transiently.
- The logic model schema is a placeholder (`acceptAnyObjectValidator`); the check steps that run on save are not registered yet.
- The upload queue MUST have a redrive policy with a dead-letter queue and a `maxReceiveCount` (suggested: 5). This is infrastructure the IaC must create; this repo does not. When `onUploaded` throws, the consumer leaves the message on the queue so SQS redelivers it, and without a dead-letter queue a poison message is redelivered forever. A poison message looks like a message that keeps reappearing with the same run ID in the "onUploaded failed" log, for example a stray `runs/<id>/input/guideline.pdf` upload for a run that does not exist, or an event that arrives before the run row is written.
- The SQS visibility timeout (default 900 s here) and `LEASE_MS` must BOTH exceed the longest single step. Redelivery of a message whose run is already running or finished is harmless, because the engine ignores a start for a run that is no longer `created`.
- If the process is killed mid-run (SIGKILL), the run keeps the dead process's lease until it expires. Every process runs `resumeAll` once at startup and then on a periodic resume sweep every `min(60 s, LEASE_MS / 2)`; the sweep picks the run up once the dead owner's lease has expired, so recovery can take up to `LEASE_MS` (plus one sweep interval) after the kill. Succeeded steps are not re-run; the interrupted step's running record is marked abandoned and the step runs again.
