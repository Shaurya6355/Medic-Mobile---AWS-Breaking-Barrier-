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
| Guideline intake (S3, Textract or alternative) | Vishnu Athreya | working locally | Backend/README.md (HTTP API); logic model JSON validated by Backend/src/pipeline/schema.ts | Backend/ (local mode: S3, SQS and state emulated on disk) | 2026-11-03 |
| Logic drafting and cross-check (Bedrock) | unassigned | not started | | | |
| Validators (completeness, exclusivity, reachability, golden cases) | unassigned | not started | | | |
| Approval steps and review UI | Vishnu Athreya | working locally | Frontend/src/api/index.ts (function list in INT-002); guidelines and draft from Backend when VITE_API_URL is set, later workflow steps still in memory | Frontend/ | 2026-11-03 |
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

### INT-002 | 2026-11-03 | Vishnu Athreya (agent) | Approval steps and review UI
What changed: Scaffolded the frontend (Vite, React 19, TypeScript, react-router, dagre) and ported a trimmed version of the mockup. The full flow works on sample data: Guidelines (upload, pick pathway and pages, create draft), Review (PO edit, clinician approve or request change, flags, AI revision accept or discard, resend), Release (synthetic check, XLSForm row diff, IT deploy approval), History (audit log, versions).
Files or resources touched: Frontend/ (package.json, src/, docs/mockup.html, docs/SPEC.md). Layout: src/domain (pure TS: types, sample data, classify, runChecks, xlsRows, rowDiff, workflow state machine), src/api (only data access; in-memory today), src/components, src/screens.
What others must do or know: Run with Node 22: cd Frontend, npm install, npm run dev (http://localhost:5173). The backend contract is src/api/index.ts: uploadGuideline(file), listGuidelines(), createDraft({guidelineId, pathway, pages}), getWorkflow(id), saveEdit(id, {item, field, patch}), sendToClinician(id), submitReview(id, itemId, decision), decideFlag(id, flagId, choice, note), returnToPO(id), decideSuggestion(id, itemId, outcome), approve(id), runVerify(id), approveDeploy(id), getAudit(id). Edits and AI revisions are both a data-only Patch (src/domain/types.ts), so the backend can schema-check them. Set VITE_API_URL once a backend exists; the api functions still need wiring to fetch.
Open items: Wire src/api to the backend and the S3 presigned upload. Verify results are simulated (the form column copies the rules). Roles are a client-side switcher, not Cognito. Not yet clicked through in a browser by a human.
Related: DEC-001, DEC-003, ART-001

### INT-003 | 2026-11-03 | Vishnu Athreya (agent) | Guideline intake pipeline, review UI
What changed: Added Backend/, a Node 22 TypeScript service for guideline intake in local mode (no AWS). Flow: presigned upload to an emulated S3 bucket, ObjectCreated event into an emulated SQS queue, a worker runs extract (PDF text layer, TXT, MD, CSV, HTML), digest (labelled blocks with page numbers) and the logic model step, which is a placeholder returning the sample cough template, Zod-validated and quote-checked against the digest. Frontend: when VITE_API_URL is set, upload goes to the backend, a pipeline loader shows each step, and Create workflow draft loads the logic model JSON. Workflow now carries `draft` (the first logic model) so Edited markers compare against it.
Files or resources touched: Backend/ (package.json, src/, test/, scripts/, samples/cough-guideline-sample.pdf, README.md). Frontend/src/api/index.ts, src/screens/GuidelinesScreen.tsx, src/domain/types.ts, src/domain/workflow.ts, src/screens/ReviewScreen.tsx, src/actions.ts, src/styles.css. Frontend/.env.local (not committed).
What others must do or know: cd Backend && npm install && npm run dev (port 8787), then run the frontend. The logic model builder is an interface (Backend/src/pipeline/logicModel.ts) for the AgentCore team to implement. Backend ModelSchema mirrors Frontend Model; change both together. Backend tests: npm test (3 end-to-end tests pass).
Open items: AWS adapters (S3, SQS, DynamoDB, Textract). AgentCore builder. Logic model format fits only the cough pathway. Pathway and page choice are not yet passed to the logic model step. Not yet clicked through in a browser by a human.
Related: DEC-004, DEC-005, DEC-006, ART-002

