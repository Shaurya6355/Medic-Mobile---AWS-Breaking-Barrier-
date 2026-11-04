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
