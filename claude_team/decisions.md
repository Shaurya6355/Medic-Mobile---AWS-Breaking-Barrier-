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
