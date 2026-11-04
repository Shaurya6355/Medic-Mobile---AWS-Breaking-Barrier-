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

### INT-007 | 2026-11-03 | utg1209 (Claude session) | BRD and system design added; logic model work starts
What changed: Added claude_team/brd.md (BRD v1.3) and claude_team/system-design.md exactly as supplied by the human, linked from claude.md (Reference documents). Recorded DEC-012 (requirements source and precedence), DEC-013 (logic model schema is system design section 4; the example tree JSON is illustrative) and DEC-014 (hybrid hosting, BRD approval order). Next build, by subagents with reviewers: a logic package (schema, DSL, interpreter, input grid) and a validation folder with the S4 checks and V1 to V7 validators, then the real fill_logic step.
Files or resources touched: claude_team/brd.md (new), claude_team/system-design.md (new), claude_team/claude.md, claude_team/decisions.md, claude_team/integration.md.
What others must do or know: Read brd.md and system-design.md. Gaps against the BRD in the existing Backend: no signatures, roles or locking on versions (AR-01 to AR-10), no single-editor lock (BR-10), rejection reasons are not fed to later drafts (GR-11), no issue register, no compiler, no build or synthetic-patient stage, no audit hash chain, no review UI. Open BRD questions still open: OQ-01 to OQ-07 (OQ-02 table layout and OQ-03 out-of-pathway children block parts of the logic model).
Open items: build the logic package and validation folder; issue register and approvals API; compiler spike; EC2 build host in Infra/ (DEC-009).
Related: DEC-012, DEC-013, DEC-014

### INT-008 | 2026-11-03 | utg1209 (Claude session) | Logic model foundations and critique
What changed: Built in Backend/src/logicModel/ (uncommitted): strict Zod schema per design section 4, canonical JSON plus SHA-256 snapshot hash, single interpreter (evaluate, trace, relevance), input grid with pairwise fallback, synthetic cough fixture, 526 tests passing in Backend (16 skipped need DynamoDB Local). Three independent critiques (clinical, formal, AI governance) found issues recorded as DEC-016 (open). The fixture is NOT a clinical reference: it misorders cough of 14 days or more, has only 4 of 13 danger signs and invented quotes. Do not use it for evals or golden cases.
Files or resources touched: Backend/src/logicModel/*, Backend/tests/logicModel/*, Backend/tests/fixtures/logicModel/*, claude_team/decisions.md (DEC-015, DEC-016).
What others must do or know: Validation folder (S4 checks) not yet built; waiting on the DEC-016 decision. Cognito added as decision DEC-015, not yet in Infra/. Ask the clinician (Medic) for: out-of-pathway ages (OQ-03), the exactly-12-months band, the drinking condition for first-dose amoxicillin, what happens when breaths are not counted.
Open items: DEC-016; validation folder; fill_logic on the new schema; Cognito and signatures (AR-01 to AR-10); fixture rebuild and 12 golden cases for Medic to confirm.
Related: DEC-013, DEC-015, DEC-016
