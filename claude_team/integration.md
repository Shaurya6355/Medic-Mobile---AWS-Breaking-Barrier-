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
| Guideline intake (S3, Textract or alternative) | Vishnu Athreya | working locally | Backend/README.md (HTTP API); logic model is a pathway spec (shared/pathway/types.ts), validated by the shared compiler | Backend/ (local mode: S3, SQS and state emulated on disk) | 2026-11-03 |
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

### INT-004 | 2026-11-04 | Vishnu Athreya (agent) | Logic model format, pathway compiler, review UI
What changed: The logic model is now the pathway spec JSON (schema_version 1.0: questions, derived, outcomes, rules with first_match_by_priority, open_questions). Added shared/pathway, a dependency-free compiler used by both Backend and Frontend: condition parser and printer, structural and semantic checks, interpreter, flow graph, XLSForm rows, quote list, boundary-value patients and threshold mutants. Backend placeholder now serves shared/pathway/samples/cough_fast_breathing.v1.json, rejects specs with compiler errors and checks each source quote is on its cited page. Frontend reads the spec everywhere: the flow chart is drawn from the rules (decision-table layout, dagre no longer used by Flow), the editor edits any field by path, rule logic is edited as text (parsed on commit), flags come from open_questions, checks are compiler diagnostics plus reachability, golden cases and cited numbers, release runs every boundary patient and the mutation test. User flow unchanged.
Files or resources touched: shared/ (new), Backend/src/pipeline/{schema,logicModel}.ts, Backend/src/worker.ts, Backend/src/state/guidelines.ts, Backend/scripts/make-sample-pdf.ts, Backend/samples/cough-guideline-sample.pdf (now 12 pages), Backend/test/*, Backend/tsconfig.json, Frontend/src/domain/*, Frontend/src/components/{Flow,NodeEditor,Tray,panels}.tsx, Frontend/src/screens/{Review,Release,Guidelines}Screen.tsx, Frontend/src/api/index.ts, Frontend/src/App.tsx, Frontend/vite.config.ts, Frontend/tsconfig.app.json. Removed Backend/src/pipeline/templates/logic-model.template.json and Frontend/docs/samples/logic-model.sample.json.
What others must do or know: AgentCore output must be a pathway spec; run validateSpec (shared/pathway/analyze.ts) on it. The UI validates the spec again when it loads it. Change the format only in shared/pathway/types.ts and analyze.ts. Golden cases live in Frontend/src/domain/data.ts, keyed by meta.pathway_id. The "live v3" baseline is a synthetic variant of the sample spec.
Open items: Pathway and page choice still not passed to the logic model step. Golden cases exist only for cough_fast_breathing. dagre is still a Frontend dependency but unused. The verify step still compares rules with themselves (cht-conf-test-harness not wired).
Related: DEC-007


### INT-005 | 2026-11-04 | Vishnu Athreya (agent) | Review UI: rule table
What changed: Review screen now leads with an editable rule table (the IR): one row per rule in priority order with condition (text form, saved as you type once it parses), outcome, follow-up day, source and status. Rows can be reordered, added (before otherwise) and deleted. A second table edits derived values. Each row's status is Edit required (blocking check), Check (warning or open flag) or OK, with the reasons listed. New drafting-quality checks: rules and outcomes written by the team rather than the guideline, and guideline items with no cited passage. View toggle: Table, Table + flow, Flow. The flow is read-only, drawn from the same model, and redraws as the table changes.
Files or resources touched: Frontend/src/components/{RuleTable,inputs,NodeEditor}.tsx, Frontend/src/screens/ReviewScreen.tsx, Frontend/src/domain/logic.ts, Frontend/src/styles.css.
What others must do or know: Live edits use the same Patch path as before, so audit and versions are unchanged (consecutive edits to one field merge into one version).
Open items: Questions are still edited from the list below the flow, not in a table.
Related: INT-004, DEC-007

### INT-006 | 2026-11-04 | Vishnu Athreya (agent) | Review UI: React Flow, table layout
What changed: The decision flow uses React Flow (@xyflow/react) with dagre layout, following the React Flow dagre example: read-only (no dragging or connecting), zoom and pan, vertical or horizontal layout, opens zoomed on the first rules. The Review screen toggle is now Table or Flow only. The rule table is reorganised: fixed columns (#, Rule, If, Then, Follow-up, Status), source page next to the rule id (quote on hover), issues listed in a row under each rule, status pill with issue count.
Files or resources touched: Frontend/package.json (+@xyflow/react), Frontend/src/components/{Flow,RuleTable}.tsx, Frontend/src/screens/ReviewScreen.tsx, Frontend/src/styles.css.
What others must do or know: Run npm install in Frontend after pulling.
Open items: none new.
Related: INT-005

### INT-007 | 2026-11-04 | Vishnu Athreya (agent) | Review journeys, IT diff, schema parity with main
What changed: Shared compiler matches main's Backend/src/logic/schema.ts: source may be one passage or a list, open_questions.resolution, only is_yes / at_least / less_than and all/any in conditions, guideline items must cite a source, severity 1 to 9. Flags: every open question goes to the PO first; the PO keeps it (note optional) or sends it to the clinician (note required); the clinician agrees (note optional) or requests a change (note required). Flags show as a card deck and on the step they belong to. Flow view: Next item button, zooms to the step being worked on and fades the rest. Clinician reviews one step card at a time with Previous / Next. PO can remove a rule from the editor. IT Release view: Changes panel with Flow (live v3 or new), JSON diff and Form diff. Removed: team-written warnings, derived-values strip under the flow, internal document references in flag text.
Files or resources touched: shared/pathway/{types,analyze,compile}.ts, shared/pathway/samples/cough_fast_breathing.v1.json, Backend/test/pathway.test.ts, Frontend/src/{domain,components,screens}/*.
What others must do or know: Flags never reach the clinician unless the PO sends them (DEC-008).
Open items: none new.
Related: DEC-008, INT-006


### INT-008 | 2026-11-04 | Vishnu Athreya (agent) | Review split layout, one-click decisions, PO can always accept
What changed: Review screen is a split: rule table or flow on the left, a sticky inspector on the right with tabs Open items, Step, Questions, Checks. Clicking an open item, a table row or a flow box opens the Step tab and centres the flow on that box. The question tray and legend no longer sit under the table. Flow boxes that are open for the current role are yellow; Changed is a badge only. Flag options that need no note decide in one click; the clinician approving a step also agrees with that step's open flags. In po_revise the PO can always accept: when the AI suggestion has no exact value, the PO types it into the prefilled field and accepts it (decideSuggestion takes an optional override patch).
Files or resources touched: Frontend/src/screens/ReviewScreen.tsx, Frontend/src/components/{Flow,FeedbackCard,panels}.tsx, Frontend/src/domain/{types,workflow}.ts, Frontend/src/{App.tsx,actions.ts,api/index.ts,styles.css}.
What others must do or know: api.decideSuggestion(id, item, outcome, patch?) has a new optional argument.
Open items: none new.
Related: INT-007

### INT-009 | 2026-11-04 | Vishnu Athreya (agent) | Check pipeline: schema, quote, number, logic, golden, cross check
What changed: Checks now run as the whiteboard pipeline, in order: 1 Schema check (gate; a failure stops the rest), 2a Quote check (each quote is in the guideline text, on the cited page), 2b Number check (each number in a guideline step is in that step's own quote), 3 Logic checks on generated sample patients (every rule reached, every patient classified, every classification reached, every threshold changes an outcome), 4 Golden cases, 5 Cross check (draft A vs draft B on the same sample patients, plus differing thresholds). 1 to 3 are the PO's to fix; 4 and 5 are for the clinician; both roles see all of them in the Checks tab. Each check is a link (/review#check-quote etc.) that opens it with its errors, and each error links to its step. Quote, number and cross-check logic is in shared/pathway/evidence.ts and is used by the backend too.
Files or resources touched: shared/pathway/{evidence,index}.ts, shared/pathway/samples/{cough-guideline.pages.json,cough_fast_breathing.v1.draftB.json}, Backend/src/pipeline/logicModel.ts, Backend/scripts/make-sample-pdf.ts, Backend/test/pathway.test.ts, Frontend/src/domain/{checks,data,logic,types,workflow}.ts, Frontend/src/components/{Checks,RuleTable,panels,FeedbackCard}.tsx, Frontend/src/screens/ReviewScreen.tsx, Frontend/src/{App.tsx,api/index.ts,styles.css}.
What others must do or know: LogicModelBuilder.build may return `alt` (draft B); the envelope carries `draftB` (null if absent or invalid). The live UI reads guideline text from GET /guidelines/:id/digest. The sample draft B is a placeholder (one threshold changed: 40 to 45) until the model produces a real second draft. The sample spec's fast_breathing cites only the 2 to 12 month passage, so the number check warns on 40 and 60.
Open items: AgentCore to produce draft B as an independent run.
Related: INT-008

### INT-010 | 2026-11-04 | Vishnu Athreya (agent) | Final cough_fast_breathing v1 logic JSON
What changed: shared/pathway/samples/cough_fast_breathing.v1.json is now the final hand-written reference (Logic_final.json): 7 rules, new derived value outside_age_range, new outcome refer_urgent_outside_age_range (out-of-range child with a danger sign: refer urgently, no medicine), fast_breathing cites both age-band passages. Only change from the upload: "(BRD OQ-03)" removed from Q2 (no internal document references in the JSON, see INT-007). Draft B regenerated from it (same single change, 40 to 45). Sample guideline text updated so every quote is on its cited page (page 8 lines without the trailing full stop, page 12 gains the OTHER PROBLEM line); sample PDF regenerated. Golden case G-14 added for the new rule. Synthetic live v3 now targets the antibiotic-referral rule by outcome, not by id.
Files or resources touched: shared/pathway/samples/{cough_fast_breathing.v1.json,cough_fast_breathing.v1.draftB.json,cough-guideline.pages.json}, Backend/samples/cough-guideline-sample.pdf, Backend/test/{pathway,pipeline}.test.ts, Frontend/src/domain/data.ts.
What others must do or know: Re-upload the sample PDF to see 36 of 36 quotes on page. All checks pass on it except the cross check, which flags the placeholder draft B on purpose.
Open items: none new.
Related: INT-009

### INT-011 | 2026-11-04 | Vishnu Athreya (agent) | AI agent replaces the PO; clinician View/Edit tabs and assistant
What changed: Workflow is none -> clinician -> verify -> deploy -> done. Roles are clinician and IT approver. createDraft runs the AI agent's pass (domain/agent.ts: checks 1 to 3, fixes a quote's cited page when it is found on exactly one other page, renumbers rule priorities) and opens the assistant with its report and one message per open question. Review screen: six check widgets side by side in the header (hover or focus expands; #check-<key> pins one), View tab (flowchart plus test patients in plain words, no table), Edit tab (rule table plus live flow), assistant on the right (what-if patients, explain a rule or derived value, propose a number change with its effect, list checks or test patients, undo). Removed: PO draft/revise states, per-step approvals, change requests, AI suggestions, flag deck, step card, tray.
Files or resources touched: Frontend/src/domain/{agent,types,workflow,checks,data,logic}.ts, Frontend/src/components/{Checks,Chat,Golden,NextStrip,RuleTable,panels}.tsx (FeedbackCard, ReviewControls, Tray, NodeEditor deleted), Frontend/src/screens/{Review,Guidelines,Release}Screen.tsx, Frontend/src/{App.tsx,actions.ts,api/index.ts,styles.css}, Frontend/docs/SPEC.md.
What others must do or know: api has undo, chat, applyProposal, dismissProposal, answer; sendToClinician, submitReview, decideFlag, returnToPO and decideSuggestion are gone. The assistant is deterministic for now; respond() in domain/agent.ts is where a Bedrock call goes.
Open items: Connect the assistant to Bedrock. Decide whether IT also sees the agent's report.
Related: DEC-009, INT-010
