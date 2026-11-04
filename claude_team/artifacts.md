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

### ART-001 | Guideline to Form mockup
Created: 2026-11-03 by Vishnu Athreya
Type: mock up
What it shows or is for: Clickable single-file React mockup of the guideline-to-form review app (all roles and states). Source for the Frontend port.
Location: committed (Frontend/docs/mockup.html, with Frontend/docs/SPEC.md)
How to regenerate or open it: Open the HTML file in a browser. It loads React and dagre from cdnjs.
Related system: Approval steps and review UI
Related: INT-002, DEC-003
Status: current

### ART-002 | Synthetic cough guideline sample PDF and logic model sample
Created: 2026-11-03 by Vishnu Athreya (agent)
Type: sample data
What it shows or is for: Two-page synthetic guideline PDF with a text layer, for testing upload, extraction and the quote check (all 8 template quotes appear in it). Plus the sample logic model JSON the review screen renders.
Location: committed (Backend/samples/cough-guideline-sample.pdf, Frontend/docs/samples/logic-model.sample.json, Backend/src/pipeline/templates/logic-model.template.json)
How to regenerate or open it: cd Backend && npm run sample-pdf. Not clinical advice.
Related system: Guideline intake
Related: INT-003, DEC-006
Status: current

