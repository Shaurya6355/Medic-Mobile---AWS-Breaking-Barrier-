# artifacts.md - Mock Ups and Artifacts

Describes every mock up or artifact created on a team member's local system, so everyone knows it exists, what it shows, and how to get it. Master rules are in [claude.md](claude.md).

Rules for this file:

- One entry per artifact, with an ID (ART-NNN) that is never reused.
- If an artifact lives only on one laptop, say so, because teammates cannot see it. Commit small artifacts to the repository (for example under artifacts/) and store large ones in S3, then record the location here.
- Describe how to regenerate the artifact, so it can be rebuilt on any laptop.
- Use only synthetic or public data in artifacts. No secrets, no personal data, no emoji.

Location values: committed (path in repository), s3 (bucket and key), local only (laptop and path).

Entry template:

```
### ART-NNN | name
Created: YYYY-MM-DD by person
Type: mock up | diagram | sample data | generated config | report | other
What it shows or is for:
Location:
How to regenerate or open it:
Related system: (see integration.md section 1)
Related: INT-NNN, DEC-NNN
Status: current | outdated | replaced by ART-NNN
```

## Artifacts

### ART-001 | Pipeline demo trace and outputs
Created: 2026-11-04 by utg1209 (Claude session)
Type: report
What it shows or is for: The whole chain on the public cough booklet with synthetic users: fill_logic (FakeModelClient), checks, findings per role, signing blocked and compile refused, officer and clinician edits as new versions, the refusals (order, separation of duties, stale sha, role mismatch), lock, release compile with the real cht-conf, and an edit after the lock. The open-question answers are TEST-ONLY placeholders, not clinical decisions.
Location: committed (Backend/pipeline-demo/output/: TRACE.md, findings-v1.json, summary.json, locked-v3.json, compile/)
How to regenerate or open it: cd Backend && npm run pipeline:demo (cht-conf part needs Backend/compile-demo/tools installed and Python 3.10 to 3.13; skipped with a message otherwise)
Related system: Approval steps and review UI; Deterministic compiler
Related: INT-011, DEC-019
Status: current
