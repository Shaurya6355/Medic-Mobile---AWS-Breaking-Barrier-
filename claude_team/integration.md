# integration.md - Shared System State and Work Log

Every team member's Claude reads this file at session start and updates it at session end. It keeps all laptops working from the same picture. Master rules are in [claude.md](claude.md).

Rules for this file:

- Pull before you read. After you update, tell the human, who reviews and pushes. Claude never pushes.
- Section 1 (system state) is edited in place by the owner of that system.
- Section 3 (work log) is append-only, newest entry at the bottom. Never edit another person's entry.
- Write what a teammate needs to know to continue without asking you.
- No emoji, no secrets, no personal data.

## 1. System state

One row per system or component. The owner keeps their row current.

| System | Owner | Status | Interface or contract | Location (repo path or AWS resource) | Last updated |
|--------|-------|--------|-----------------------|--------------------------------------|--------------|
| Guideline intake (S3, Textract or alternative) | unassigned | not started | | | |
| Logic drafting and cross-check (Bedrock) | unassigned | not started | | | |
| Validators (completeness, exclusivity, reachability, golden cases) | unassigned | not started | | | |
| Approval steps and review UI | unassigned | not started | | | |
| Deterministic compiler (XLSForm, tasks.js) | unassigned | not started | | | |
| Build-and-test container (cht-conf, test harness) | unassigned | not started | | | |
| CHT test instance and test data | unassigned | not started | | | |
| Infrastructure as code | unassigned | not started | | | |
| Audit records (S3, DynamoDB) | unassigned | not started | | | |

Status values: not started, in progress, working locally, integrated, blocked.

## 2. Team and environments

| Person | Laptop or environment | Systems they own | Notes |
|--------|-----------------------|------------------|-------|
| | | | |

Shared environment settings every laptop must match:

- Node.js 22, Python 3.10 or later, Docker with Compose v2, git.
- AWS region us-west-2.
- Claude Code on Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION=us-west-2`.
- Add further shared settings here as they are agreed.

## 3. Work log (append only)

Entry template:

```
### INT-NNN | YYYY-MM-DD | person | system
What changed:
Files or resources touched:
What others must do or know:
Open items:
Related: DEC-NNN, ERR-NNN, ART-NNN
```

### INT-001 | 2026-11-03 | team | shared setup
What changed: Created claude_team with claude.md, integration.md, decisions.md, errors.md and artifacts.md.
Files or resources touched: claude_team/*
What others must do or know: Pull, then read claude.md first. Follow its session start and session end steps.
Open items: Assign owners in section 1. Decide DEC-001 (path) and DEC-002 (reference documents in repo).
Related: DEC-001, DEC-002

### INT-002 | 2026-11-03 | utg1209 (Claude session) | Guideline intake and extraction
What changed: Designed and first-tested the extraction stage for Guideline_Docs/Cough_Guideline.pdf (cough and fast breathing scope only). Added deterministic pre-processing (page images, numbered blocks with bounding boxes), the extraction system prompt with schema, and a Bedrock runner that logs tokens, cost and latency (DEC-003) and checks every quote against its block. Ran the prompt once as a throwaway in-session test (not Bedrock): 38 nodes, 14 edges, 9 variables, 13 danger signs, 4 thresholds, 5 actions, 3 follow-ups, 1 unclear item, 0 quote failures.
Files or resources touched: Backend/extraction_test/ (prepare_input.py, system_prompt.txt, run_extraction.py, input_blocks.json, pages/, extraction_output.json); claude_team/decisions.md (DEC-003 to DEC-005); claude_team/errors.md (ERR-001).
What others must do or know: extraction_output.json is the preliminary record the logic-model stage will read. It was produced in-session, not by a Bedrock model, so tokens, cost and latency are unmeasured. To run on Bedrock: set AWS credentials, pip install boto3, set MODEL_ID to a us. inference profile (and optionally PRICE_IN_PER_MTOK, PRICE_OUT_PER_MTOK), then python3 Backend/extraction_test/run_extraction.py. Logic model is not built yet.
Open items: Bedrock model ID and credentials; Amazon Transcribe scope question (DEC-004); UI for showing unclear items; assign an owner in section 1.
Related: DEC-003, DEC-004, DEC-005, ERR-001

### INT-003 | 2026-11-03 | utg1209 (Claude session) | Orchestration layer (Backend/src)
What changed: Built the orchestrator on local branch orchestrator-core (32 commits, not pushed). Upload (S3 -> SQS) starts a run: ingest, extract (Bedrock via Strands), placeholder fill_logic creating logic-model version 1. Versioned saves, comments, per-step tokens/cost/latency (DEC-003), retries, lease-based resume with a periodic sweep, DynamoDB and S3 stores, Fastify API with routes only in Backend/src/contract/ (DEC-007), Dockerfile, README. Extraction scripts moved to Backend/extraction (final prompt: final_prompt.txt).
Files or resources touched: Backend/src, Backend/tests, Backend/package.json, Backend/Dockerfile, Backend/README.md, Backend/extraction (moved from extraction_test, not otherwise edited); claude_team/decisions.md (DEC-006 to DEC-008); docs/superpowers/specs and plans (git-ignored).
What others must do or know: 236 tests pass, tsc and build clean. NOT verified against real AWS: DynamoDB, S3, SQS, Bedrock/Strands, and the Docker image was never built. DynamoStore contract tests run only with DYNAMODB_ENDPOINT set. The API has no authentication. The logic model schema is a placeholder (Backend/src/steps/logicModelValidator.ts is the one place to replace). Hosting is undecided: claude.md says EC2 containers; DEC-006/DEC-008 want Strands on AgentCore (needs organiser confirmation). The upload queue needs a dead-letter queue (see Backend/README.md).
Open items: logic model schema; hosting (OI-6/OI-7); IaC; check steps to run on save (hook is Backend/src/index.ts onVersionSaved); deferred: versionId on StepRecord, step metric logging to CloudWatch.
Related: DEC-003, DEC-006, DEC-007, DEC-008

### INT-004 | 2026-11-03 | utg1209 (Claude session) | Infrastructure as code (Infra/)
What changed: Added AWS CDK (TypeScript) project Infra/ with OrchestratorDataStack: artifact S3 bucket (CORS, upload event to SQS for runs/*/input/guideline.pdf), upload queue plus DLQ (visibility 1200 s, maxReceiveCount 5), five DynamoDB tables matching Backend/src/store/dynamoStore.ts, least-privilege managed policy for the app (DynamoDB, S3 incl. ListBucket, SQS, Bedrock for the us. inference profile and underlying model), project tag, outputs mapped to Backend env vars. Reviewed by a separate reviewer; findings fixed. Rule added to claude.md: infra code is updated with every backend change (DEC-009).
Files or resources touched: Infra/ (new), claude_team/claude.md, claude_team/decisions.md (DEC-009, DEC-008 update).
What others must do or know: 21 tests pass, tsc clean, cdk synth works offline. NOT deployed; a human with sandbox credentials runs cdk bootstrap and cdk deploy. No compute stack yet: AgentCore Runtime is session-invoked (POST /invocations, ARM64, SigV4/OAuth), so it does not fit the SQS consumer and sweep; recommended split is orchestrator in a container, AgentCore for the agent steps. Awaiting human choice.
Open items: compute and AgentCore stack; organiser confirmation of AgentCore (DEC-008); API authentication.
Related: DEC-006, DEC-008, DEC-009

### INT-005 | 2026-11-03 | utg1209 (Claude session) | Lambda hosting, AgentCore option, CI
What changed: (1) Backend runs in three modes (RUN_MODE container | lambda | agentcore) and has two model backends (MODEL_BACKEND bedrock | agentcore). New routes: GET /ping (all modes), POST /events (lambda only, SQS and scheduled events, partial batch failures via batchItemFailures), POST /invocations (agentcore mode only). Lambda mode awaits background work and has a 14-minute deadline; LEASE_MS must exceed 900000 in lambda mode. Per-step attempt cap of 6, ingest size (MAX_PDF_BYTES) and page-count checks, Backend/.env.example added. (2) Infra/ gained OrchestratorLambdaStack (ARM64 container Lambda, SQS trigger batch 1, EventBridge 5 minute schedule, HTTP API with 9 explicit contract routes and no /events, /invocations or /ping) and, only with -c modelBackend=agentcore, OrchestratorAgentCoreStack. The Bedrock invoke permission moved to its own managed policy BedrockInvokePolicy. Upload queue visibility is 5400 s. (3) New AgentService/ package: Strands agent behind /invocations and /ping for AgentCore Runtime; always answers HTTP 200 with an ok/kind envelope. AgentCore payload cap is 100 MB (verified from AWS quotas page). (4) .github/workflows/ci.yml runs tests, builds and synth for Backend, AgentService, Infra and Docker (amd64 and arm64, lambda target); it never deploys. (5) claude.md: infra-as-code rule (DEC-009) and Lambda allowed (DEC-010). requirements.txt now lists boto3.
Files or resources touched: Backend/, AgentService/ (new), Infra/ (new), .github/ (new), requirements.txt, .gitignore, claude_team/claude.md, decisions.md.
What others must do or know: Tests: Backend 420 passed (16 skipped, need DynamoDB Local), AgentService 28, Infra 54; tsc, builds and cdk synth (both modes) clean. NOT verified on real AWS: nothing deployed, Docker images never built (no daemon), AgentCore path untested against the real service. The API has NO authentication and every run is a paid model call: add an authorizer or WAF and a budget alarm before sharing the URL. A human with sandbox credentials runs cdk bootstrap and cdk deploy --all (Docker must be running). Wire schemas in Backend/src/model/agentcoreWire.ts and AgentService/src/contract.ts are duplicated; a drift test in AgentService/tests covers it. A later review found and fixed a wrong SQS reply key and AgentCore error mapping.
Open items: organiser approval of AgentCore (DEC-008) and API Gateway/EventBridge (DEC-011); API authentication; presigned POST with a size cap for uploads; logic model schema; real-AWS verification; cross-stack exports make some replacements fail.
Related: DEC-006, DEC-008, DEC-009, DEC-010, DEC-011

### INT-006 | 2026-11-03 | utg1209 (Claude session) | Infrastructure phase closed, next: logic model
What changed: Infrastructure and hosting work (INT-004, INT-005) is complete as code and tests. Added Infra/DEPLOY_CHECKLIST.md (one-page human deploy checklist). Real-AWS deploy and smoke test are deferred by the human; the team moves to the logic model step that follows extraction. A sample logic model file cough-pathway-logic-tree-v0.9.json (schema_version 2.0: inputs, external_dates, derived, actions, tree, flags) exists at the repo root, untracked.
Files or resources touched: Infra/DEPLOY_CHECKLIST.md (new), claude_team/integration.md.
What others must do or know: Status of the infra steps: code complete and reviewed; not deployed; not verified on real AWS. The logic model placeholder is Backend/src/steps/fillLogic.ts and Backend/src/steps/logicModelValidator.ts; both get replaced when the logic model design is agreed.
Open items: logic model design (fill step, validator, unclear section, version 1); deploy and smoke test; API authentication; organiser approvals (DEC-008, DEC-011).
Related: INT-004, INT-005, DEC-011

### INT-007 | 2026-11-03 | Nirubama12 (Claude session) | Cross-check stage (Backend/cross-check)
What changed: Backend/cross-check is a copy of Backend/extraction with the same file names and the same process (prepare_input.py, run_extraction.py, final_prompt.txt, build_flow.py, input_blocks.json, extraction_output.json), run on a second model, Llama 4 Scout 17B Instruct. Differences from the extraction copy: run_extraction.py reads CROSSCHECK_MODEL_ID (and optional CROSSCHECK_MAX_TOKENS, AWS_REGION) from the environment or Backend/.env, and parses a reply that Llama wrapped in fences or text (recorded as json_was_wrapped in _run); final_prompt.txt adds five lines requiring JSON only with every list present. The schema in the prompt is byte-identical to the extraction prompt. Backend/.env.example gained CROSSCHECK_MODEL_ID, CROSSCHECK_MAX_TOKENS and price variables. Backend/cross-check/pages is git-ignored.
Files or resources touched: Backend/cross-check/ (new), Backend/.env.example, .gitignore, claude_team/decisions.md (DEC-012, DEC-013), claude_team/integration.md.
What others must do or know: Nothing was run against Bedrock. The copied extraction_output.json in cross-check is the in-session sample and will be overwritten by a Llama run; do not compare it with the extraction one. Page images are git-ignored and absent: run prepare_input.py on the PDF in each folder. The two folders are not kept in sync; a change to the input or schema in one must be copied to the other. Not yet done: Backend/validation (compare the two extraction_output.json files and produce flags), wiring both models in parallel in the TypeScript engine, Infra BedrockInvokePolicy for the two new models (DEC-009), UI for flags. Not committed or pushed.
Open items: Haiku 5.5 and Llama 4 Scout us. profile ids; whether Llama 4 Scout takes 12 images and the output token cap; DEC-013 confirmation; record the model comparison results.
Related: DEC-003, DEC-005, DEC-012, DEC-013

### INT-008 | 2026-11-03 | Nirubama12 (Claude session) | Validation (Backend/validation)
What changed: Added Backend/validation/compare_outputs.py: a deterministic comparer (no model, no network) that reads Backend/extraction and Backend/cross-check extraction_output.json plus both input_blocks.json and writes flags.json (models, file sha256, summary counts per list, a no-flags notice, and the flag list). Each flag has id, status (open), severity (high, medium, low), type (missing_in_crosscheck, missing_in_extraction, value_mismatch, unclear_item, invalid_quote, invalid_output, input_mismatch), category, pdf_page, a summary sentence, per-field extraction and crosscheck values, both items, and sources with block_id and exact quote. Rules are in DEC-014.
Files or resources touched: Backend/validation/compare_outputs.py (new), claude_team/decisions.md (DEC-014), claude_team/integration.md.
What others must do or know: Run: python3 Backend/validation/compare_outputs.py (flags.json is written in that folder; it is generated, not committed by this change). Tested only on mutated copies of the sample output in /tmp: renamed ids (zero flags), changed thresholds, dropped and extra items, dropped edge and node, invented quote, unclear items, missing list, changed goto, different input, repeat run gives identical bytes. No test files were added to the repository. With the two identical sample outputs the only flag is the page-reference ambiguity both copies carry (ERR-001). Nothing was run against Bedrock. The output files do not record the model id yet, so flags.json shows "not recorded in the output file" until real runs write _run.model_id (the cross-check copy already does; the extraction copy does not).
Open items: Zod schema for Flag and a route such as GET /runs/:id/flags in Backend/src/contract (DEC-007); wiring into the TypeScript engine; recording each clinician decision on a flag against the version; tuning after the first real runs; add model_id to extraction/run_extraction.py _run.
Related: DEC-012, DEC-013, DEC-014, INT-007
