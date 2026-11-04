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

### DEC-003 | Trimmed review UI for the first frontend build
Status: decided
Date: 2026-11-03
Decided by: Vishnu Athreya
Feature or area: Approval steps and review UI
Decision: Build a trimmed version of the mockup. Kept: Guidelines, Review, Release, History screens; dagre flow; flags; checks; AI revision card; next-step strip; role switcher. Dropped for now: Compare screen (phone preview, side-by-side flows, outcome-change table), page thumbnails and page preview, plain-language rules tab, undo and reset-to-draft, the JSON/XLSForm/XForm code diffs and tasks.js diff, Runs screen.
Assumptions: The core approval flow matters more for the demo than the comparison views. Dropped parts are still in Frontend/docs/mockup.html and can be ported later.
Why: Human asked to trim the UI significantly and make it work.
Other options considered (and why not):
- Full port of the mockup: more surface to wire to a backend in the time available.
Revisit if: reviewers need the v3 vs new comparison before approving. Note that dagre plus react-router does not match the cht-ui-builder stack (React Flow, Zustand), so DEC-001 may require a change here.
Related: INT-002, DEC-001

### DEC-004 | Intake pipeline runs in local mode first
Status: decided
Date: 2026-11-03
Decided by: Vishnu Athreya
Feature or area: Guideline intake
Decision: Build the pipeline against on-disk emulators of S3, SQS and the state table behind interfaces, with local text extraction instead of Textract.
Assumptions: No AWS credentials on this laptop yet. AWS adapters can replace the emulators without changing the worker or the HTTP API.
Why: Human chose fully local, no AWS, for now.
Other options considered (and why not):
- Build against real AWS now: no credentials or bucket available.
- Canned demo only: would not exercise a real upload, event and extraction.
Revisit if: AWS sandbox access is set up.
Related: INT-003

### DEC-005 | S3 event to queue to worker, no Lambda
Status: decided
Date: 2026-11-03
Decided by: Vishnu Athreya
Feature or area: Guideline intake
Decision: The bucket notification sends ObjectCreated events under uploads/ to a queue; a worker in the backend container polls it (visibility timeout, 3 receives, then dead-letter).
Assumptions: SQS is acceptable under the Technical Environment Document's optional services; this has not been checked against the document.
Why: Human chose the event-driven route. Lambda for application logic is out of scope (claude.md).
Other options considered (and why not):
- Backend starts processing after the browser reports the upload: simpler, not event-driven.
Revisit if: SQS turns out to be out of scope.
Related: INT-003

### DEC-006 | Logic model step is a placeholder until AgentCore
Status: decided
Date: 2026-11-03
Decided by: Vishnu Athreya
Feature or area: Logic drafting
Decision: No model call. The step returns the sample cough-pathway template through a LogicModelBuilder interface; output is Zod-validated and quote-checked like any future model output. The UI labels it as a placeholder.
Assumptions: The team plans AgentCore, choosing models per task, instead of a direct Bedrock call. Whether AgentCore fits the rule that model calls go through Bedrock needs checking.
Why: Human asked to keep the model step blank for now.
Other options considered (and why not):
- Direct Bedrock call: team is moving to AgentCore.
- Leave the step empty: the review screen would have nothing to render.
Revisit if: AgentCore integration starts, or the logic model format is generalised beyond the cough pathway.
Related: INT-003, DEC-001

### DEC-007 | Logic model is a pathway spec, compiled by shared code
Status: decided
Date: 2026-11-04
Decided by: Vishnu Athreya
Feature or area: Logic drafting, review UI, compiler
Decision: The logic model is the pathway spec JSON (schema_version 1.0) the human supplied. One dependency-free compiler in shared/pathway does validation, evaluation, flow graph and XLSForm for both Backend and Frontend.
Assumptions: Hit policy is first match by priority with exactly one final otherwise rule. A comparison on a hidden or unanswered field is false. Show conditions may only use earlier questions. Derived values are yes/no.
Why: Human asked for the JSON to drive the flow as a logical, compiler-like rule set, keeping the user flow. Sharing the code keeps backend validation and UI behaviour identical.
Other options considered (and why not):
- Map the JSON onto the old fixed d1/d2/d3 model: lossy, breaks for any other pathway.
- Separate Zod schema in Backend and hand-written checks in Frontend: two copies drift.
Revisit if: A pathway needs a different hit policy, numeric derived values, or select-multiple questions.
Related: INT-004, DEC-006

