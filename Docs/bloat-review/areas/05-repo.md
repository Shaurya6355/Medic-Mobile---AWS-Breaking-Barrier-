# Area 05: REPO (python, extraction, cross-check, root files, claude_team, docs)
Scope: Backend/extraction, Backend/cross-check, Backend/validation (compare_outputs.py), requirements.txt, root README/DEPLOYMENT/Final_Logic_Model/.gitignore, claude_team/, Docs/, Guideline_Docs/, Frontend/, .github/, Backend/README.md, Infra/README.md, Infra/DEPLOY_CHECKLIST.md, Backend/.env.example (Python lines).
Not covered: fixture contents (TESTS), compile-demo/pipeline-demo output (COMPILE), TS source.
Summary: Biggest wins are the byte-identical copies in cross-check/ (prepare_input.py, build_flow.py, input_blocks.json 61 KB, and extraction_output.json 38 KB, which is NOT a Llama output) about 110 KB, and the 4 overlapping deploy docs with several stale/contradictory statements (Backend/README "reject not built", "no auth", "hosting undecided", "docker not built"). claude_team/ (146 KB) is AI-process material but DEC-xxx are cited by code and READMEs, so keep decisions.md. Python pipeline is an offline experiment; the server needs only 3 files. Overall: modest bloat, doc staleness is the main real problem.

## Findings

### REPO-01  cross-check/ holds byte-identical copies of extraction/ files
- Category: DUP
- Where: Backend/cross-check/{prepare_input.py 1.9 KB, build_flow.py 8.2 KB, input_blocks.json 61 KB, extraction_output.json 38 KB}
- Evidence: `diff` of each against Backend/extraction/<same name>: all four identical (no output). Only run_extraction.py (Llama variant, env CROSSCHECK_MODEL_ID, fence-tolerant parse) and final_prompt.txt (adds 5 "reply must start with {" lines) genuinely differ. compare_outputs.py defaults read ../extraction and ../cross-check, so run with defaults it compares a file with itself (zero flags). extraction_output.json is supposed to be Llama 4 Scout output (run_extraction.py writes `_run.model_id`), so this copy is either a placeholder copy or the cross-check was never committed.
- Proposed action: delete the four identical files from cross-check/; have cross-check/run_extraction.py read ../extraction/prepare_input.py and input_blocks.json (or make the script take a --blocks path). Commit a real Llama output only if the demo needs it.
- Size: ~110 KB, 4 files
- Risk: CHECK (compare_outputs.py and cross-check/run_extraction.py read these from their own folder; one-line path change needed)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-02  Offline experiment pipeline: only 3 extraction files are used by the server
- Category: DEAD
- Where: Backend/extraction/{run_extraction.py 2.9 KB, build_flow.py 8.2 KB}, Backend/cross-check/{run_extraction.py 3.8 KB, build_flow.py, final_prompt.txt 5.3 KB, prepare_input.py}, Backend/validation/compare_outputs.py 18.6 KB, requirements.txt
- Evidence: Dockerfile line 28 copies only extraction/prepare_input.py, final_prompt.txt, fill_prompt.txt. Grepped whole repo (excluding node_modules/.git/compile-demo) for run_extraction, build_flow, compare_outputs, cross-check: hits only in Backend/.env.example (comments 30-34), claude_team/{decisions,integration,system-design}.md, and the scripts themselves. No npm script, CI step, test or TS file runs them. CI (.github/workflows/ci.yml) is node + docker only. extraction/ files that ARE used by tests/scripts: extraction_output.json and input_blocks.json (tests/signoff/helpers.ts, tests/steps/*.test.ts, tests/validation/helpers.ts, scripts/fillLive.ts, Final_Logic_Model.md extract-pages) - keep those.
- Proposed action: decide whether the two-model cross-check (DEC-021/022/023) is a deliverable. If yes keep as-is (folder them under one `experiments/` or document in one README). If not, remove cross-check/ (all), validation/compare_outputs.py, extraction/run_extraction.py, extraction/build_flow.py. Note the TS validator (Backend/src/validation, DEC-023) now does flagging in the server, so compare_outputs.py may be superseded; confirm with owner Nirubama12 (INT-013/014).
- Size: ~50 KB code plus REPO-01 data
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-03  requirements.txt (boto3) is not needed by anything deployed
- Category: DEP
- Where: /requirements.txt (0.5 KB)
- Evidence: Lambda image runs python only for extraction/prepare_input.py, which is stdlib (file's own comment says so) plus poppler. boto3 is used only by the two run_extraction.py scripts (offline). Dockerfile does not copy or pip-install it; no CI step uses it.
- Proposed action: keep only if REPO-02 keeps the Python scripts; otherwise remove together with them. Move to Backend/extraction/requirements.txt if kept.
- Size: 0.5 KB
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-04  Backend/README.md "Not verified / known gaps" contradicts the code and other docs
- Category: DOC
- Where: Backend/README.md lines 138-144 (also 26, 108, 122), 25 KB file
- Evidence: (a) line 144 says Reject (BR-17, AR-06) is "not built", but src/api/server.ts:293 registers routes.pattern.reject and calls signoff.reject (DEC-020), and DEPLOYMENT.md section 10 says "partly or not built". Release to IT/lock/urgent were not individually re-checked (urgent RR-02 is in the same reject comment). (b) line 140 "Hosting is undecided ... EC2 vs AgentCore" contradicts DEC-014 (hybrid Lambda, decided) and DEC-011; it also points at docs/superpowers/specs/..., a path that is gitignored (.gitignore has Docs/superpowers) so a clone does not have it. (c) line 138 "Docker image was not built" contradicts CI docker job and DEPLOYMENT.md section 9 ("Verified in CI"). (d) "no authentication" appears 4 times in Backend/README, again in Infra/README, DEPLOY_CHECKLIST and DEPLOYMENT sec 8, 10: one fact stated 6 times.
- Proposed action: fix (a)-(c); state "no auth" once (DEPLOYMENT.md sec 8) and link to it from the others.
- Size: ~10 lines wrong; ~3 KB removable repetition
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-05  Four overlapping deploy documents
- Category: DOC
- Where: DEPLOYMENT.md 12.9 KB, Infra/README.md 13.9 KB, Infra/DEPLOY_CHECKLIST.md 2.3 KB, Backend/README.md 25 KB (Deploy/CI/Docker sections)
- Evidence: Deploy steps (login, bootstrap, `cdk deploy --all`, smoke test, tear down) appear in DEPLOYMENT.md sec 4-7, Infra/README "Deploying (human steps)" and DEPLOY_CHECKLIST (all three). "Before you share the URL / no auth / budget alarm / DLQ alarm" appears in DEPLOYMENT sec 8, Infra/README "Cost and abuse guardrails", DEPLOY_CHECKLIST "Known gaps". "Not built yet" lists in DEPLOYMENT sec 10 and Infra/README "Deliberately missing" overlap (auth, build host, VPC, alarms). Differences are real drift: DEPLOY_CHECKLIST says expect final state in_review, DEPLOYMENT says awaiting_officer; checklist default model us.anthropic.claude-sonnet-4-5 vs what the code defaults to (not verified here).
- Proposed action: make DEPLOYMENT.md the single runbook; delete DEPLOY_CHECKLIST.md (2.3 KB, fully covered); cut Infra/README "Deploying" and "Cost and abuse" to one link line each; keep Infra/README for stack/env-var mapping only.
- Size: ~6-8 KB
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-06  Docs/superpowers plans and specs (33 KB) exist on disk, ignored, and are cited as if present
- Category: DOC
- Where: Docs/superpowers/plans/2026-11-03-orchestrator-core.md 22 KB, Docs/superpowers/specs/2026-11-03-orchestrator-design.md 11 KB
- Evidence: .gitignore line 12 ignores Docs/superpowers, `git ls-files Docs` empty. Referenced from Backend/README.md line 140 and claude_team/decisions.md/integration.md. Not shipped, so not repo bloat; but dangling references.
- Proposed action: leave ignored; remove the dangling pointer (see REPO-04b) or commit the spec if it is the OI-6/OI-7 source.
- Size: 0 tracked
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-07  claude_team/ (146 KB tracked) is AI-process material; partly duplicated, partly cited
- Category: DOC
- Where: claude_team/*.md
- Evidence (file, size, content):
  - decisions.md 37 KB, 340 lines: DEC-001..DEC-023 decision log (reference vs open path, hosting, Cognito, v1.json contract, sign-off hardening, two-model extraction, validator rules). CITED: DEC-014/015/019/020/021 etc. appear in Backend/src/signoff/signoff.ts, api/server.ts, compiler/compileSnapshot.ts, contract/schemas.ts, ~10 test files, Infra/README, DEPLOYMENT.md, Backend/README, Infra/lib. Do NOT delete or renumber. Rule inside: entries never deleted.
  - system-design.md 36 KB, 455 lines: end-to-end design (stages, checks, AI touchpoints); partly superseded by DEC-017 (schema) and by Backend/README; refers to a non-existent `explore/ingest.py`.
  - integration.md 30 KB, 153 lines: system-state table (rows still "not started", owner "unassigned" - stale) plus INT-001..014 append-only work log. This is the largest duplicate of Backend/README/DEPLOYMENT content.
  - brd.md 20 KB, 313 lines: business requirements and agreed design rules (BR/AR/RR IDs). Final_Logic_Model.md cites `docs/BRD.md` in the ignored logic-model/ dir, a copy. Keep one.
  - errors.md 11.8 KB, 208 lines: ERR-NNN tracker; not looked at in detail (check whether any Pending entry is still open before cutting).
  - claude.md 8.4 KB, 104 lines: master rules for team Claude sessions (no emoji, scope, session start/end). It is the instruction file loaded by claude/CLAUDE.md (ignored).
  - artifacts.md 2.1 KB, 38 lines: ART-NNN log; header and rules only (no entries seen in head; verify).
- Proposed action: keep decisions.md and brd.md (cited). Candidates to trim: integration.md section 1 table (stale, "not started" rows) and the INT log if the team stops using the session protocol; system-design.md once superseded. artifacts.md looks empty: remove if no entries. Needs the owner's call because claude.md makes teammates' sessions read all five files at start.
- Size: up to ~50-80 KB (integration + system-design + artifacts), not decisions
- Risk: CHECK
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-08  Frontend/sample.txt is a placeholder
- Category: DEAD
- Where: Frontend/sample.txt (27 bytes: "Sample frontend text file.")
- Evidence: Only tracked file under Frontend/. Referenced by DEPLOYMENT.md:260 ("only Frontend/sample.txt exists") only to say there is no frontend. No code or CI reads it.
- Proposed action: remove (or keep an empty dir README if the folder must exist) and reword DEPLOYMENT.md:260 to "no frontend".
- Size: 0.03 KB
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-09  Final_Logic_Model.md (9 KB) is untracked and describes ignored files
- Category: DOC
- Where: /Final_Logic_Model.md
- Evidence: not in `git ls-files`, not ignored; documents logic-model/ (ignored by .gitignore:19, has its own node_modules and README.md 9 KB, package.json, checks/, guideline_text/) and references its extract-pages script reading Backend/extraction/input_blocks.json. Looks like a copy of logic-model/README.md (same size 9177 B). Also root v1.json and cough-pathway-logic-tree-v0.9.json are ignored, on disk only (DEC-017 names v1.json as the contract; the live copy is Backend/src/logic or fixtures - not checked here).
- Proposed action: do not commit; either delete the local copy or gitignore it. Check whether logic-model/ (with node_modules) should be tracked at all (owner's decision; belongs to CHECKS area).
- Size: 9 KB local
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-10  Guideline_Docs/Cough_Guideline.pdf is ignored but referenced as a test input
- Category: DOC
- Where: Guideline_Docs/Cough_Guideline.pdf (1.5 MB, ignored via *.pdf); Infra/DEPLOY_CHECKLIST.md "Before you start"; Backend/src/validation/checks/guidelineFile.ts
- Evidence: `git ls-files | grep -i pdf` returns no PDFs; a fresh clone cannot follow the checklist step. Not bloat in git (0 bytes tracked) but a missing-input pointer.
- Proposed action: keep ignored; note in README where to download the WHO/UNICEF booklet.
- Size: 0
- Risk: SAFE
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### REPO-11  Root README.md is a 2-line stub
- Category: DOC
- Where: /README.md (53 B)
- Evidence: contents are the title and "AWS Hackathon". claude_team/claude.md/BRD say the README must list each tool/service chosen and why. Not bloat; a gap.
- Proposed action: keep; later point to DEPLOYMENT.md and Backend/README.md.
- Size: n/a
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

## Looked at and fine
- Dockerfile copies exactly extraction/prepare_input.py, final_prompt.txt, fill_prompt.txt: do not remove those three.
- extraction/extraction_output.json (38 KB) and input_blocks.json (61 KB) are used as real fixtures by tests and scripts/fillLive.ts: keep in extraction/ (TESTS area may move them).
- extraction/final_prompt.txt vs cross-check/final_prompt.txt: legitimately different (Llama needs JSON-only reminder), but 90% shared text.
- .github/workflows/ci.yml (2.7 KB): lean, no references to python scripts.
- Backend/.gitignore and root .gitignore are fine; Backend/extraction/pages and cross-check/pages are ignored (generated).
- Backend/.env.example lines 30-34 document the Python script env vars; update only if REPO-02 removes them.
- DEC numbers: DEC-001..023 all present in decisions.md; citations resolve.

## Cross-area pointers
- TESTS: tests/signoff/helpers.ts, tests/validation/helpers.ts, steps/extract.test.ts, fillLogic.test.ts all read extraction/input_blocks.json (61 KB) and extraction_output.json; if these move out of extraction/ the TS paths change.
- CHECKS/COMPILE: logic-model/ (ignored, has node_modules) and Final_Logic_Model.md describe a separate checker (checks/check.mjs) that may duplicate Backend/src/validation; Backend/scripts/compileLocked.ts and fillLive.ts reference extraction/ paths.
- PLATFORM: Infra/README.md and DEPLOY_CHECKLIST contain the duplicated deploy/auth text (REPO-05); Docker image-build claim in Backend/README is stale vs CI docker job.
