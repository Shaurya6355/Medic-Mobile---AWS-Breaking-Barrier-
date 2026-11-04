# decisions.md - Features, Assumptions and Options Considered

Records each feature or choice, the assumption behind it, why it was chosen, and what other options existed. Master rules are in [claude.md](claude.md).

Rules for this file:

- One entry per decision, with an ID (DEC-NNN) that is never reused.
- Do not delete entries. If a decision changes, set the old one to superseded and add a new entry that references it.
- Record assumptions explicitly, so a teammate can tell what to recheck if the assumption fails.
- No emoji, no secrets, no personal data.

Status values: open, decided, superseded.

Entry template:

```
### DEC-NNN | title
Status:
Date:
Decided by:
Feature or area:
Decision:
Assumptions:
Why:
Other options considered (and why not):
Revisit if:
Related: INT-NNN, ERR-NNN
```

---

### DEC-001 | Reference path or Open path
Status: open
Date: 2026-11-03
Decided by: pending
Feature or area: overall build approach
Decision: not yet made.
Assumptions: The team has not yet chosen between the two paths in the Technical Environment Document.
Why: Needed before any component is built, because it fixes the stack and the editor.
Other options considered (and why not):
- Reference path: build on Medic's cht-ui-builder (React, Vite, Zustand, React Flow, Fastify, pnpm). Lets Medic merge the branch. Constrains the stack.
- Open path: choose own inputs, tools and AWS services. Freer. Must still use Bedrock, containers on EC2, synthetic data, and cht-conf output, and the README must justify each tool.
Revisit if: not applicable until decided.
Related: INT-001

### DEC-002 | Keep reference documents inside the repository
Status: open
Date: 2026-11-03
Decided by: pending
Feature or area: team setup
Decision: not yet made. Proposal: copy the Technical Environment Document and Vision Document into the repository (for example under docs/).
Assumptions: Documents are currently only on one laptop, outside the repository.
Why: Every teammate's Claude needs the same source of truth for scope.
Other options considered (and why not):
- Leave outside the repository: teammates and their Claude cannot read them reliably.
- Link only to the original location: depends on each laptop having the same path.
Revisit if: the documents are updated by Medic.
Related: INT-001

### DEC-003 | Monitor tokens, cost and latency for every process
Status: decided
Date: 2026-11-03
Decided by: human (requested at start of extraction design)
Feature or area: observability across the whole pipeline
Decision: Every process (extraction, logic drafting, validation, compile, build-and-test) records input tokens, output tokens, running cost and latency, per process and per run, keyed by run ID and snapshot ID.
Assumptions: Budget is $500 per sandbox, so cost must be visible during the run, not only afterwards. Bedrock responses report token usage.
Why: Controls spend, shows where latency comes from, and supplies the cost-per-run figure required in the README.
Other options considered (and why not):
- Check the AWS bill afterwards: too late and not per process.
- Monitor model calls only: misses non-model steps (Textract, build) that add cost and latency.
Revisit if: the chosen tracing tool (CloudWatch or Langfuse) cannot hold per-process records.
Related: INT-001

### DEC-004 | Audio input: assume transcript is supplied
Status: open
Date: 2026-11-03
Decided by: human (provisional)
Feature or area: extraction stage, voice and interview inputs
Decision: Design extraction to accept text transcripts. Assume audio is transcribed before it reaches extraction. Whether Amazon Transcribe may be used (it is not on the in-scope AWS list) is being checked with the organisers.
Assumptions: Bedrock Claude models do not take audio input. A transcript (with speaker labels if available) can be produced upstream.
Why: Keeps extraction design unblocked while the scope question is checked.
Other options considered (and why not):
- Use Amazon Transcribe now: not on the approved list, needs confirmation first.
- Drop audio from the demo: loses an input type the vision names.
Revisit if: organisers confirm or refuse Transcribe.
Related: DEC-003

### DEC-005 | Extraction: one whole-document call, cough and fast breathing scope only
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: extraction stage (guideline PDF to preliminary record)
Decision: Extraction reads the whole PDF in one Bedrock call (page images plus numbered text blocks) and copies only cough, fast breathing, danger sign, referral, amoxicillin, home-care and follow-up content into a fixed JSON schema (nodes, edges, variables, danger_signs, thresholds, actions, followups, unclear_items). Every item cites block_id and an exact quote. The model uses no outside knowledge and makes no clinical judgement. Unclear items are raised only when the page itself is unreadable, contradicts itself or has an arrow readable two ways, and are shown to a person in the UI. Prompt and schema: Backend/extraction_test/system_prompt.txt.
Assumptions: The booklet is 12 pages, so one call fits. The flow graph is kept as ordered nested nodes because the logic model needs ordered decision tables (FIRST hit policy). Out-of-scope content (diarrhoea, malaria, HIV/TB, MUAC, ORS, zinc, AL, vaccines) is ignored except as goto nodes.
Why: Cough pathway spans pages 5 to 11 through "go to page X" links, so a per-page call would need a second stitching pass. Code-side quote checks stop invented pointers.
Other options considered (and why not):
- One call per page plus a stitching pass: more calls and a second prompt for cross-page links.
- Extract the whole booklet: adds out-of-scope branches as noise and raises cost.
Revisit if: a longer guideline exceeds one call, or the Bedrock run misses quotes the in-session test passed.
Related: DEC-003, DEC-004, INT-002, ERR-001

### DEC-006 | Orchestrator built on Strands Agents, hosted on AWS (not EC2)
Status: open (hosting part), decided (Strands part)
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: orchestration layer (Backend/src)
Decision: The agentic core uses Strands Agents in TypeScript. Each model-backed step is a Strands agent; the orchestrator owns step order. Hosting is on AWS but not EC2.
Assumptions: Strands is allowed as a library calling Bedrock. A non-EC2 AWS compute service can be approved.
Why: Human preference for an agent framework and managed AWS hosting.
Other options considered (and why not):
- Plain TypeScript steps with the Bedrock SDK: fewer dependencies, no agent framework.
- EC2 containers: matches claude.md rules, but human asked for something else.
Revisit if: organisers reject Strands, or reject every non-EC2 compute option.
Related: DEC-001, DEC-003. Conflicts with the compute rule in claude.md; claude.md not changed. Design: docs/superpowers/specs/2026-11-03-orchestrator-design.md (OI-6).

### DEC-007 | API routes are one fixed contract used by all files
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: orchestrator API
Decision: Route names, methods and shapes are defined once in Backend/src/contract/ (constants plus Zod schemas) and imported everywhere. No path strings elsewhere.
Assumptions: UI and backend are TypeScript and can share the module.
Why: Prevents drift between UI, server and tests across several people.
Other options considered (and why not):
- Per-file route strings: drift and silent breakage.
- OpenAPI first: heavier than needed for a hackathon.
Revisit if: the UI is not TypeScript.
Related: DEC-006

### DEC-008 | Use Amazon Bedrock AgentCore for hosting agents
Status: open (pending organiser confirmation)
Date: 2026-11-03
Decided by: human (utg1209), provisional
Feature or area: orchestrator hosting
Decision: Use Amazon Bedrock AgentCore (for example AgentCore Runtime) to host the Strands-based agent steps, as the non-EC2 hosting in DEC-006.
Assumptions: AgentCore can be used in the sandbox account and counts as an allowed AWS service. It is not on the approved list in the Technical Environment Document.
Why: Human preference; Strands has a documented TypeScript deployment path to it.
Other options considered (and why not):
- EC2 containers: matches claude.md, human prefers managed hosting.
- Lambda or Fargate: forbidden for app logic by claude.md.
Revisit if: organisers refuse AgentCore, or the budget or sandbox blocks it.
Related: DEC-006

### DEC-009 | Infrastructure code is written and kept current with every backend change
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: infrastructure as code
Decision: AWS infrastructure is defined in AWS CDK (TypeScript) in the Infra/ directory. Any change that adds or alters an AWS resource, an environment variable, or an IAM permission the application needs must update Infra/ in the same piece of work. Rule added to claude.md (Technical standards).
Assumptions: CDK in TypeScript fits the TypeScript stack and is one of the two options claude.md allows (Terraform or CDK).
Why: Hand-built resources drift and cannot be reviewed; permissions must match what the code calls.
Other options considered (and why not):
- Terraform: allowed, but a second language for a TypeScript team.
- Manual console setup: not reproducible, not reviewable.
Revisit if: organisers require Terraform.
Related: DEC-006, DEC-008

Update 2026-11-03 (DEC-008): human (utg1209) confirmed the choice is AgentCore for hosting. Status stays open only until the organisers confirm AgentCore is allowed in the sandbox. Infra/ will gain an AgentCore Runtime stack; EC2 is the fallback if refused.

### DEC-010 | Lambda is allowed for application logic
Status: decided
Date: 2026-11-03
Decided by: human (utg1209), reported as confirmed with the organisers
Feature or area: compute scope
Decision: AWS Lambda may be used for application logic. The claude.md out-of-scope entry for Lambda is removed.
Assumptions: The organiser confirmation was received outside this repository; no written reference is available here.
Why: Removes the forbidden-service constraint on hosting choices (DEC-006, DEC-008).
Other options considered (and why not): none.
Revisit if: the organisers contradict this in writing.
Related: DEC-006, DEC-008

### DEC-011 | Orchestrator runs on Lambda (container image); AgentCore is an optional model backend
Status: decided (AgentCore part open pending organiser approval, see DEC-008)
Date: 2026-11-03
Decided by: human (utg1209), implemented by Claude session
Feature or area: hosting
Decision: The orchestrator runs as an AWS Lambda container image behind the AWS Lambda Web Adapter (RUN_MODE=lambda): API Gateway HTTP API with explicit contract routes, SQS event source for uploads, EventBridge rate(5 minutes) schedule as the only recovery path for runs cut off by the 15-minute limit. The same image also runs as a plain container (RUN_MODE=container). Strands agent calls run in-process on Bedrock by default (MODEL_BACKEND=bedrock). If the organisers approve AgentCore, MODEL_BACKEND=agentcore calls the AgentService (AgentService/, AgentCore Runtime, ARM64) instead; the stack is only created with cdk -c modelBackend=agentcore. No EC2 or Fargate stack is built.
Assumptions: Lambda is allowed (DEC-010). API Gateway and EventBridge are used as glue for Lambda and are not named in any decision or the approved service list; confirm with organisers. The API has no authentication yet.
Why: No servers to run; fits an event-driven pipeline; steps are idempotent and leases make cut-off runs resumable.
Other options considered (and why not):
- EC2 containers (claude.md): servers to manage; a long-running consumer is not needed.
- Whole orchestrator on AgentCore Runtime: sessions are invoked and stopped when idle, which does not fit a queue consumer and sweep.
Revisit if: organisers refuse API Gateway/EventBridge, or a single step must exceed 15 minutes.
Related: DEC-006, DEC-008, DEC-009, DEC-010

### DEC-012 | BRD and system design adopted as the requirements source
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: requirements
Decision: claude_team/brd.md (BRD v1.3) and claude_team/system-design.md are the requirements and design source for the build. Work cites BRD ids. Precedence on conflicts: BRD over the system design for approvals and sign-off order; decisions.md (DEC-010, DEC-011, DEC-014) over the system design for hosting and tooling; claude.md hard rules over both.
Assumptions: Both documents were pasted by the human as the team's agreed versions; the BRD live copy is newer if they differ.
Why: Most of what is being built (logic model, checks, approvals, compile, test, release) is defined there.
Other options considered (and why not): Keep working from the earlier plan (superseded by the design itself, D-012 in the design numbering).
Revisit if: the BRD change log gains a new version, or the design review changes the open decisions in section 19.
Related: DEC-013, DEC-014

### DEC-013 | Logic model schema is system design section 4 (decision tables); the example tree JSON is illustrative
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: logic model
Decision: The logic model is variables, relevance, decision tables with hit_policy FIRST or UNIQUE and rules using the JSON condition DSL, outcomes, followups and clinical_text (system design section 4). cough-pathway-logic-tree-v0.9.json (tree, derived, flags) only illustrates how a finished model can look and is not the schema. Checks in system design section 4 S4 plus extraction validators V1 to V7 live in a validation folder and run on every snapshot, AI-drafted or hand-edited. Assumption for V1 and V2 (not defined in the repo): V1 = the document parses and satisfies the strict schema; V2 = every reference resolves and types, operators, options and ids agree.
Assumptions: V1 and V2 meaning chosen by Claude on the human's instruction to use judgment; OQ-02 (how the table holds question order, relevance, field types and limits) is still open.
Why: The BRD and design describe tables and grid-based checks, which a tree does not support directly.
Other options considered (and why not): Tree as the stored shape (checks would have to be rewritten per path); tree compiled to a table (extra step with no benefit for one pathway).
Revisit if: OQ-02 is answered differently, or the team defines V1 and V2 differently.
Related: DEC-005, DEC-012

### DEC-014 | Hosting reconciled: hybrid (Lambda for API and orchestrator, EC2 only for build and test); approvals follow the BRD
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: hosting and approvals
Decision: (1) Keep Lambda plus CDK (DEC-009, DEC-010, DEC-011) for the API and orchestrator. Add one EC2 container host only for compile, build and synthetic-patient stages (cht-app-ide needs the SYS_ADMIN capability and Chromium, which Lambda cannot give). The system design's all-EC2, Docker Compose and Terraform plan is not followed. (2) Approvals: BRD order governs (program officer signs, then clinician, version locks, IT releases); the design supplies the mechanism (approval bound to the snapshot hash, roles enforced by the API, separation of duties). (3) Numbered versions stay; each gains snapshot_sha, signatures and status per AR-01 to AR-10. (4) The orchestrator state machine is extended with the design's approval, compile, build, test and deploy states.
Assumptions: The EC2 build host can be added to Infra/ later; API Gateway and EventBridge approval from organisers still outstanding (DEC-011).
Why: Keeps the hosting already built and reviewed while meeting the build container's needs.
Other options considered (and why not): Follow the design fully (discards built Lambda and CDK work); Lambda only with CodeBuild (unapproved service, riskier).
Revisit if: organisers refuse API Gateway or EventBridge, or the EC2 host cannot be added in time.
Related: DEC-009, DEC-010, DEC-011, DEC-012

### DEC-015 | Real sign-in with Cognito (three groups) so separation of duties can hold
Status: decided (implementation not started)
Date: 2026-11-03
Decided by: human (utg1209), after a critique that found the API has no identity (author is client-supplied)
Feature or area: identity and roles
Decision: Add Amazon Cognito (user pool, groups program_officer, clinician, it) and a JWT authorizer on the HTTP API. Roles and the acting user are derived server-side from the token, never from the request body. Enforces BRD section 4 and AR-03/AR-08. Added to Infra/ per DEC-009 when built. Sign and release actions will be conditional DynamoDB transactions with Signature, Decision, edit-lock and latest-signed records.
Assumptions: Cognito is an approved or approvable AWS service (the system design already uses it); not yet confirmed with organisers.
Why: Without identity, no BRD approval rule can be demonstrated.
Other options considered (and why not): Build identity later (the signature flow depends on it); API keys (no per-user identity).
Revisit if: organisers refuse Cognito.
Related: DEC-012, DEC-014

### DEC-016 | Logic model v2 proposal (open, under team discussion)
Status: open
Date: 2026-11-03
Decided by: pending (human is discussing with a teammate)
Feature or area: logic model schema and checks
Decision: Not yet made. Three independent critiques (clinical safety, formal soundness, AI governance) recommend: outcome severity tiers owned by the clinician with a blocking check that a lower-severity rule can never override a higher one; mandatory required on questions that rules read and an explicit could-not-measure choice; drop != and UNIQUE tables for the MVP; named table outputs (age_band, fast_breathing, any_danger_sign, dose) and a collect-all treatment table; structured doses and clinical text with sources; separate entry limits; needs_value holes allowed in drafts only; exact region-search checks (NOT PROVEN blocks approval) instead of pairwise sampling; code-generated gap findings (12-month overlap, scope edges, danger-sign coverage); fill_logic outputs references to extraction ids with code expanding numbers, operators, catch-all and clinical text; rebuild the fixture as a port of the v0.9 tree on real block ids, verified by Medic.
Assumptions: Critique files are in the session scratchpad; clinician answers needed for OQ-03, exact 12 months, the drinking condition for first-dose amoxicillin, and breaths-not-counted.
Why: The critiques found that the current schema and fixture could let a lower-priority rule hide an urgent referral and treat unmeasured children as normal.
Other options considered (and why not): minimal patch (add only severity, required and danger-sign checks), which leaves derived values and doses outside the model.
Revisit if: the clinician or team rejects tiers or named outputs.
Related: DEC-013

Update 2026-11-03 (DEC-016): human (utg1209) answered the proposal. Decided: (1) outcome severity ranks, clinician-owned; (2) a catch-all outcome receives anything unclassified or unmeasured (to be a declared, clinician-chosen fallback, with its region shown to reviewers); (4) the generation step is extraction record -> logic model, and clinical text is copied by code from the extraction (it already holds verbatim text, block ids and quotes); (5) a derived-values section is required (age band, fast breathing, any danger sign, doses); (6) numbers, operators and the catch-all are written by code, not AI; (7) access control (DEC-015). Quote check (V3) and number check (V4) are the first validators to build. Point 3 (drop != and unique-match tables) was not answered: Claude's call is to drop both for the MVP and add a collect-all table mode, reversible.

Update 2026-11-03 (DEC-013): the implemented logic model is schema_version 2 (Backend/src/logicModel/schema.ts), which supersedes system-design.md section 4 (schema_version 1) where they differ: no != operator, hit policies FIRST and COLLECT only (no UNIQUE), range renamed entry_limits, outcomes are objects with a severity rank, a required derived section, structured actions with sources, clinical_text with sources, a mandatory catch-all as the last FIRST rule, followups name their table. Cross-references and uniqueness (declared variables, outcome ids, table ids) are enforced by the validators (Backend/src/validation/checks/schemaReferences), not by the schema parse; no model may reach evaluate or enumerateGrid without passing them.

### DEC-017 | v1.json is the logic model contract (supersedes the section-4 style schema)
Status: decided
Date: 2026-11-03
Decided by: human (utg1209)
Feature or area: logic model contract
Decision: The team's hand-written v1.json (repo root; schema_version "1.0": meta, scope, questions, derived, outcomes with actions/dose_by_age/follow_up/severity, hit_policy first_match_by_priority, rules with priority and an "otherwise" catch-all, open_questions with route_to) is the logic model the pipeline generates and validates. Backend/src/logicModel (built to system-design section 4, DEC-013 v2) is to be rewritten around it; the canonical hash and the validation framework carry over. v1.json becomes the fixture and golden reference. Conditions use only is_yes, at_least, less_than, all, any (plus the "otherwise" rule); sources are {page, quote} and are checked against the page text. Items to settle in the merge: severity convention (v1.json: lower number is more urgent), several sources per item (a derived value or rule cites more than one quote), meta.file_sha256 must equal the sha256 of the PDF actually used (v1.json says a489..., repo PDF is 0d74...), block ids on sources if the extraction supplies them.
Assumptions: The cht-conf compile contract (project directory with forms/app/<id>.xlsx, properties.json, tasks.js, targets.js, translations, .eslintrc, base_settings.json, contact-summary.js) is met by a compileSnapshot step that writes a base-project template plus files generated from the model.
Why: v1.json matches the BRD (rule table, order, shown_when, entry constraints, open questions, provenance) and uses a closed operator set that compiles safely to XLSForm.
Other options considered (and why not): keep the section-4 schema and convert v1.json into it (two shapes to maintain).
Revisit if: the compiler needs fields v1.json lacks (form id and title, contact types, task window after due).
Related: DEC-012, DEC-013, DEC-016

### DEC-018 | Question flow is derived from the rules at compile time; flow mode is a clinical choice
Status: decided (mode choice open, pending clinician)
Date: 2026-11-04
Decided by: human (utg1209) asked for a tree-like flow; mode choice for Medic
Feature or area: form flow and compiler
Decision: The compiled form shows one question per screen and, by default (flowMode minimal), asks only the questions that can still change the outcome. The flow is derived deterministically from the signed rule table (Backend/src/logic/flow.ts) and emitted as relevance by the compiler; the signed model vocabulary is unchanged (the flow uses a compile-only is_no atom and a never constant). The compiler refuses to build if the shortened flow ever gives a different outcome than the full answers. flowMode options: full, minimal, danger_signs_always. Skipped questions are saved blank in the CHT report; blank must not be read as no.
Assumptions: All questions in v1.json are required. The minimal flow never asks danger-sign questions of a child outside the age range (the Q2 hazard made silent); the clinician must choose the mode before any release.
Why: Fewer questions per child (3.19 on average against 8.92 on the grid) with proven identical outcomes over all 6400 answer combinations.
Other options considered (and why not): Hand-written shown_when in v1.json (can drift from the rules); asking every question (the previous behaviour).
Revisit if: the clinician requires all danger-sign questions, or v1.json gains questions that are not required.
Related: DEC-016, DEC-017

### DEC-019 | Signatures bind to modelSha on the version record; lock, gates and compile guard enforced in code; identity deferred
Status: decided (auth seam open until DEC-015 is built)
Date: 2026-11-04
Decided by: human (utg1209) set the rules in the task; mechanism chosen by Claude
Feature or area: approval steps, versioning, compile
Decision: (1) A signature is {runId, n, modelSha, role, userId, signedAt}, appended to the version item by one conditional write (DynamoDB transaction: ConditionCheck that the version is still the latest, plus an Update conditioned on order, sha and user). The body artifact is never rewritten (AR-01). (2) The program officer signs first, the clinician second, two different people; the clinician's signature on the same sha sets status locked (AR-03, AR-05). (3) The request names the modelSha the signer reviewed; a different sha is refused, and stored signatures only count for the sha of the current body (AR-07). Only the latest version can be signed, so any edit starts over with zero signatures (AR-02, AR-04); a locked version stays locked and is the releasable one (AR-09, shown as latestLocked). (4) A signature is refused while validation/gates.ts has blocking findings for that role (officer: officer-owned; clinician: clinical, including open questions routed to the clinician). An open question is settled by a new version that marks it resolved with a written resolution; warnings do not block. (5) Findings are stored per content at runs/<id>/checks/<modelSha>.json and recomputed on demand if missing. (6) compileSnapshot release builds require the lock evidence and re-check it; compileLockedVersion reads it from the store; compile runs as a job (scripts/compileLocked.ts), not in Lambda (DEC-014). (7) Run states checking, awaiting_officer, awaiting_clinician, locked; a saved version goes back through checking from any review state. (8) AUTH SEAM: role and userId come from the request body until Cognito is built (DEC-015); the server still checks the role against the endpoint and every rule above.
Assumptions: Signature and lock records on the version item (non-key attributes) are enough for the MVP; no separate signatures table. Preview builds stay unguarded because they are stamped not approved and not deployable. Routing note: fill_logic routes the out-of-age-range handling and the catch-all choice (team items) to the program officer, although both are clinical in nature. With this design the officer can settle them alone, which weakens "clinical changes need a clinician" (GR-02). Recommended: route them to the clinician in src/logic/fill/resolve.ts (not changed in this work).
Why: Approval must bind to one exact snapshot (GR-04) and the rules must hold even under races or a hand-built approval object, so the store, the service and the compiler each enforce them.
Other options considered (and why not): A separate signatures table (more Infra and env for no extra guarantee now); signatures bound to version number only (an edited body would keep its approval); trusting the API client for order and roles (no enforcement); compiling inside the Lambda (cht-conf needs Python, the test harness needs Chromium, DEC-014).
Revisit if: Cognito lands (drop role and userId from the body, take them from the token); reject with comment (AR-06) or urgent marking (RR-02) are built; the team wants warnings to need explicit acceptance before signing.
Related: DEC-012, DEC-014, DEC-015, DEC-017, INT-011

### DEC-020 | Sign-off hardening after red team 3: nothing stored is trusted for a gate; settings, bytes and identity bound
Status: decided (auth seam still open until DEC-015 is built)
Date: 2026-11-04
Decided by: human (utg1209) set the fixes in the task; mechanism chosen by Claude
Feature or area: approval steps, checks, compile guard, API
Decision: (1) Stored findings (runs/<id>/checks/<CHECKS_VERSION>/<modelSha>-<inputsSha>.json) are a cache for the views only: zod-validated, gates and role views recomputed from the findings, never the stored booleans. A signature, a rejection and a release build run runChecks again. CHECKS_VERSION (src/signoff/checks.ts) is in the key; bump it when a check changes. (2) Check inputs: golden cases and compile settings come from the run's artifacts runs/<id>/inputs/{golden_cases,compile_settings}.json, then GOLDEN_CASES_PATH / COMPILE_SETTINGS_PATH, then the repository defaults (TODO: the proposed golden cases tests/fixtures/logic/golden-proposed.json and compile-demo/settings.demo.json). Missing defaults mean "not supplied" and the findings, the gate summary and the sign result say plainly which checks did not run (checksNotRun). (3) Each signature records settingsSha (sha256 of the canonical settings the checks used); both signatures must agree and a release build must use exactly those settings. The manifest key is runs/<id>/compile/<modelSha>/<settingsSha>/manifest.json; the audit records settingsSha, bodySha256, checksVersion, inputsSha, whether golden cases ran. (4) verifyLocked refuses anything but the newest locked version (AR-09), a version whose stored bytes differ from Version.bodySha256 (recorded at save; also refused at sign time) or that has no bodySha256, and a build whose fresh checks block. (5) compileSnapshot no longer accepts caller-built lock evidence: release builds name the stored version (release: {store, artifacts, runId, n}) and go through releaseBuild/compileLockedVersion, which run verifyLocked. (6) userIds are normalised (NFKC, invisible format characters removed, trimmed, lower case) and restricted to [a-z0-9._@-], 1 to 128 characters, in the request schema, Signoff, rules.ts and both stores. (7) Open questions: with the version chain, removing a question, rerouting it, an answer first written in a version saved by another role than route_to (Version.authorRole, from the save request), and a clinician answer without the clinician's name and a change note all block; an empty or trivial answer ("x", one word, under 15 characters) blocks in every version. The first version is not compared (fill_logic writes every question open; the API cannot create a root version). (8) Save: 422 version_mismatch when meta.version / meta.parent_version disagree with the n and parent the store assigns; the response carries checks_status ok|failed; a failed check after save leaves the run failed at the checks step (resume retries it); a run left in awaiting_clinician or locked while the newest version cannot take that signature heals back on the next status, sign or reject. (9) Reject (AR-06, RR-02): POST /runs/:id/versions/:n/reject {role: clinician, userId, modelSha, comment, itemRef?, urgent}; only after the officer signed, by someone else, on the latest version; the version gets status rejected (kept, never signable or buildable), the comment is stored against itemRef, the run returns to awaiting_officer, the fix is a new version.
Assumptions: Until Cognito (DEC-015) the store's version rows are trusted for who signed: a person who can write DynamoDB directly can still forge a locked row with settingsSha. A root version comes only from fill_logic. The default golden cases are proposals for v1.json (outcome id refer_outside_age_range), so against the fill model three of them are GOLDEN_INVALID and block the clinician until the run supplies its own cases; this is visible, not silent.
Why: Red team 3 opened every gate with a planted findings file, released an older locked version, changed the build output with unsigned settings, signed both roles as "alice" and "Alice", settled clinician questions by deleting them or writing "x", and bypassed the store with hand-made lock evidence.
Other options considered (and why not): Signing the findings record (no key management before Cognito/KMS); trusting a cache with an integrity hash (an attacker who writes S3 writes the hash too); comparing open questions with the parent only (a later version launders a wrong answer); rejecting userId variants with 400 instead of folding them (a typo would split one person into two).
Revisit if: Cognito lands (userId = token sub, authorRole = token group, drop both from the body); the clinician confirms golden cases for the fill pathway (replace the default); a settings upload endpoint is added; checks become slow enough that re-running them per signature matters.
Related: DEC-009, DEC-015, DEC-019, INT-012, ERR-002 to ERR-011
