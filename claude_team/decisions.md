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
