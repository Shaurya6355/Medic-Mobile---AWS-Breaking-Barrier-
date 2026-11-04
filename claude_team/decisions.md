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
