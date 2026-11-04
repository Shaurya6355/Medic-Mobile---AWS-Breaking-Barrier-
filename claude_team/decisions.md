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

### DEC-012 | Two-model extraction: Claude Haiku 5.5 extracts, Llama 4 Scout 17B Instruct cross-checks
Status: decided
Date: 2026-11-03
Decided by: human (Nirubama12)
Feature or area: extraction and cross-check stages (Backend/extraction, Backend/cross-check)
Decision: Extraction runs on Claude Haiku 5.5. In parallel, cross-check runs the same task on Llama 4 Scout 17B Instruct, both through Amazon Bedrock. A deterministic validator in Backend/validation compares the two outputs and produces a list of flags for the clinician UI. Haiku's output is the source for logic-model version 1; Llama's output is used only to raise flags.
Assumptions: Llama 4 Scout was the second best model in the human's comparison (the comparison results are not recorded in the repository yet). Llama 4 Scout accepts the 12 page images and system prompt through Converse and can return the full schema; neither is verified.
Why: A second, independent model catches copy errors and omissions that one model repeats silently, and the tech document asks for an independently prompted cross-check.
Other options considered (and why not):
- Same model run twice: shares the same blind spots.
- A second Claude model: the human's comparison ranked Llama second best.
- A model judging the two outputs: prohibited (no model-as-judge); comparison is deterministic code.
Revisit if: Llama cannot take the page images or returns invalid JSON often (flags become noise), or the cost per run is too high.
Related: INT-007, DEC-003, DEC-005

### DEC-013 | Compare the extraction schema outputs until the logic model schema exists
Status: open
Date: 2026-11-03
Decided by: proposed by Claude session, awaiting human confirmation
Feature or area: validation (Backend/validation)
Decision: Until a real logic model schema is agreed, both models emit the extraction schema (nodes, edges, variables, danger_signs, thresholds, actions, followups, unclear_items) and the validator compares those. Items are aligned by cited block_id and quote, not by model-chosen ids.
Assumptions: The extraction schema carries enough structure to compare. INT-006 mentions a sample logic model file (cough-pathway-logic-tree-v0.9.json, schema_version 2.0) that is untracked; it has not been reviewed for this purpose.
Why: Unblocks the validator and flag schema now. Node ids differ between models, so block_id and quote are the only stable anchors.
Other options considered (and why not):
- Wait for the logic model schema: blocks the validator work.
- Align by node id or text similarity: unstable across models, and fuzzy matching is harder to trust.
Revisit if: the logic model schema is agreed, then the comparison moves to it.
Related: INT-007, DEC-012

### DEC-014 | Validator flag rules: alignment, severity and what counts as a difference
Status: decided; pairing and severity rules superseded in part by DEC-016
Date: 2026-11-03
Decided by: Claude session, from the human's request for a deterministic comparer (Backend/validation)
Feature or area: validation, flags for the clinician UI
Decision: The comparer pairs items across the two outputs by the block they cite (block_id), best field agreement first, never by model-chosen ids. It compares only fields that come from the document or carry clinical meaning (thresholds: op, value, unit, age_band; actions: drug, dose, age band, frequency, duration, trigger; danger signs: text, cough_relevant; follow-ups: text, due text, trigger; node and edge text, kind, parent, goto target, branch). It does not compare ids, variable names or labels. Severity: high for any clinical value, missing threshold, action, danger sign, follow-up or edge, a quote not found in its block, an invalid output list, different input, or an ambiguity both models raised; medium for wording, structure and an ambiguity only one model raised; low for page number, action type and missing variables. The validator recomputes every quote check itself and does not trust the _run block.
Assumptions: Two models describing the same box cite at least one common block_id. Wording differences in free-text fields are worth a person's glance. Agreement is not correctness, so the output carries a notice saying so.
Why: Ids differ between models, so block_id is the only stable anchor, and it gives every flag a page and quote for the clinician. Excluding model-chosen names avoids noise that would hide real flags.
Other options considered (and why not):
- Align by node id or fuzzy text similarity: unstable, and fuzzy matching is hard to audit.
- A model judging the differences: prohibited.
- Compare every field: floods the clinician with naming noise.
Revisit if: the first Bedrock runs show too many or too few flags, or the logic model schema replaces the extraction schema (DEC-013).
Related: INT-008, DEC-012, DEC-013

### DEC-015 | Cross-check sends the guideline to Llama in batches of 3 pages
Status: decided
Date: 2026-11-04
Decided by: human (Nirubama12)
Feature or area: cross-check stage (Backend/cross-check/run_extraction.py)
Decision: Llama 4 Scout receives the guideline in 4 requests of 3 pages each (run in parallel, 8192 output tokens each, temperature 0.1). The prompt file is unchanged; each request adds a batch note (id prefix b<N>_, go-to links to other batches written as page:<N>). Code merges the four results: lists are concatenated, variables are merged by id, node order is offset per batch, and page:<N> links resolve to the first top-level node of that page. Haiku 5.5 keeps the single whole-document call (DEC-005) and runs without a temperature setting.
Assumptions: Llama 4 Scout allows at most 3 images and 8192 output tokens per request (verified by test calls on 2026-11-04). Edges that cross a batch boundary are lost and appear as flags.
Why: The two limits make a single call impossible for Llama; batching is the only option that keeps the page images.
Other options considered (and why not):
- Tile 4 pages per image: arrows may become unreadable and the output cap would still cut the JSON.
- Text blocks only: loses arrows and layout, so the cross-check would differ more from Haiku.
Revisit if: Llama raises its limits, or the first comparison shows the batching causes most flags.
Related: ERR-003, DEC-005, DEC-012, INT-010

### DEC-016 | Comparer tuning after the first real Haiku vs Llama comparison
Status: decided (provisional; thresholds are not yet checked against a clinician's judgement)
Date: 2026-11-04
Decided by: human (Nirubama12) asked for the tuning; rules chosen by the Claude session
Feature or area: validation (Backend/validation/compare_outputs.py); supersedes parts of DEC-014
Decision: (1) Items are still paired by cited block first; leftovers are then paired by matching text (similarity at least 0.8 for nodes and follow-ups, 0.85 for danger signs, 0.7 for actions by drug name, exact for thresholds). (2) A field difference that is only wording (units written another way, "in 3 days" against "3 days", a leading "Age", spelling amoxycillin or amoxicillin, one text containing the other) is a low flag and is never dropped; a real value difference keeps its severity. Numbers, operators, kind and boolean fields are always strict. (3) An unpaired danger sign, follow-up or node that repeats an item already compared is low and says so. (4) Missing nodes and missing edges are grouped into one flag per page and side, with the members listed in the flag; items that cite no source are one flag per list. (5) Edges whose two ends sit in different cross-check batches are low, as an expected gap of batching (DEC-015). (6) The model id of each side is read from the output, else from run_metrics.json beside it. Danger signs, actions, follow-ups and thresholds stay one flag each.
Assumptions: The similarity cut-offs and the unit and spelling synonyms are the session's choices. Wording differences are worth showing but not worth a high flag.
Why: The first comparison gave 185 flags (133 high), most of them wording or granularity noise that hid the real problems. After tuning it gives 103 (51 high, 33 medium, 19 low) on the same two outputs.
Other options considered (and why not):
- Drop wording differences completely: hides changes a clinician may care about, and breaks the rule that ambiguity is never settled silently.
- Fuzzy-match everything: harder to audit; kept to the leftover pass only.
Revisit if: a clinician finds a flag graded too low, or the logic model schema replaces the extraction schema (DEC-013).
Related: DEC-013, DEC-014, DEC-015, INT-011

### DEC-017 | Model outputs are never committed or pushed
Status: decided
Date: 2026-11-04
Decided by: human (Nirubama12)
Feature or area: repository hygiene for extraction, cross-check and validation runs
Decision: Nothing a model produced is committed or pushed: raw replies (raw_response.txt), run metrics (run_metrics.json), flags (Backend/validation/flags.json) and real extraction outputs. These paths are git-ignored. The two extraction_output.json files already in git are the old in-session samples; they are restored to that committed content and marked skip-worktree locally, so later runs that overwrite them do not show in git status. Real outputs from the first runs were copied outside the repository (/tmp/model_outputs_backup on the running laptop).
Assumptions: The two committed extraction_output.json files stay in main as sample data (they came from an in-session test, not Bedrock). skip-worktree is local to one clone and each laptop must set it for itself.
Why: Model outputs are generated and can be large; they should not be mistaken for reviewed data, and the human wants none of them in git.
Other options considered (and why not):
- Remove the two sample files from git: changes main and the scripts and comparer read them as defaults; to be decided with the team.
- Change the scripts to write outputs into a git-ignored output folder: cleaner, but changes paths in three scripts; not done yet.
Revisit if: the team wants run outputs kept as artifacts (then record them in artifacts.md and store them in S3).
Related: INT-012, INT-009, INT-010, INT-011
