# Guideline to Form: UI spec and handover

Mock-up for the No-Code CHT Configuration build (AWS Breaking Barriers 2026, Medic). All content is synthetic sample data. Nothing here is clinical guidance.

## What is in this package

| Path | What it is | Use it to |
|---|---|---|
| `index.html` | Standalone clickable mock-up. Open in any browser, no build, no network except Google Fonts. | Demo the flow; merge screens into another HTML artifact |
| `SPEC.md` | This file: flow, roles, screens, states, data model | Build the real UI and API |
| `design-source/` | The Claude Design canvas files (`canvas.json`, `Main.dc.html`, `wf/*.dc.html` wireframes) | Re-import into a Claude Design canvas, or read the template and logic |
| `samples/` | Sample guideline PDF (clean) and an annotated copy with pipeline notes | Test extraction; write golden cases |

## Roles (Cognito groups in the real app)

| Role | Can do | Cannot do |
|---|---|---|
| AI agent (system) | Run checks 1 to 3 (schema, quotes, numbers, logic), fix what is safe to fix in code (cited page, rule priorities), put the open questions to the clinician, answer the clinician in the assistant and propose changes | Change the rules without the clinician applying it; approve or deploy |
| Clinician | Start a workflow from guideline pages; View tab (flowchart, test patients, six checks); Edit tab (rule table, flow redraws live); answer open questions; apply assistant proposals; undo; approve | Deploy |
| IT approver | Approve deploy after the synthetic patient check | Approve content |

No single person drafts, approves and deploys (brief, design rule 2).

## End-to-end flow

1. **Guidelines.** Clinician uploads a file, picks a pathway and pages, clicks **Create workflow draft**.
2. **Extraction (system).** Index pages → Bedrock drafts A and B with verbatim quotes.
3. **AI agent.** Runs checks 1 Schema, 2a Quote, 2b Number, 3 Logic; fixes a quote cited on the wrong page and gaps in rule priorities; everything else it reports. Puts every open question to the clinician in the assistant.
4. **Clinician.** View tab: flowchart only, test patients (golden cases) in plain words, the six checks as header widgets (hover to expand). Edit tab: the rule table; every edit redraws the flow and re-runs the checks. The assistant answers what-if patients, explains rules, and proposes changes with their effect on sample and test patients; nothing changes until the clinician clicks Apply. **Approve and send to IT** unlocks when no check is blocking and every question is answered.
7. **Verify.** After clinician approval: build the form, then run synthetic patients through (a) the approved rules in code and (b) the filled form via cht-conf-test-harness. All must match; any mismatch returns to the clinician.
8. **Changes.** PR-style diff of the XLSForm rows (old v2 vs new), test report. **IT approver** clicks **Approve deploy**.
9. **Audit.** Append-only log of every step.

## Screens

| # | Screen | Key elements |
|---|---|---|
| 1 | Guidelines | Add files dialog (folders, file list, multi-select, *Files of type* dropdown, Open/Cancel); library list with type badge, reader, status; selected-file panel: pathway pills, **Pages to read** (Auto from TOC / Page ranges / Pick pages), page preview (thumbnail strip, large page view, include/exclude), existing form, **Create workflow draft** |
| 2 | Runs | Stage list with done / current / to-do, who owns each stage |
| 3 | Review | Question cards (role-dependent actions), version history, flags, automatic checks |
| 4 | Verify | Summary tiles, patient table: inputs, expected (rules), actual (form), match |
| 5 | Changes | Diff of form rows (+/−), state badge, deploy button |
| 6 | Audit | Time, event, by, version, note |

## File types and readers

| Type | Extensions | Reader |
|---|---|---|
| PDF | .pdf | Textract (LAYOUT + TABLES) |
| Word | .doc .docx .odt .rtf | Convert to PDF in a container (LibreOffice), then Textract |
| Spreadsheet | .xlsx .xls .csv .ods | Read cells directly (best for WHO SMART DAK tables) |
| Image | .png .jpg .tif .webp .heic | Textract OCR + model for charts |
| Web or text | .html .htm .txt .md | Extract text directly, cite by section |
| Other | anything else | Uploads, marked **Unsupported**, cannot start a workflow |

## Workflow states

`none → po_draft → clinician → (po_revise → clinician)* → verify → deploy → done`

| State | Owner | Exit |
|---|---|---|
| `po_draft` | PO | Send to clinician |
| `clinician` | Clinician | Return to PO (≥1 rejected) or Approve all (all approved, 0 open flags) |
| `po_revise` | PO | Resend (every rejected question edited or AI revision accepted) |
| `verify` | System | Synthetic check passes → Send to IT |
| `deploy` | IT approver | Approve deploy |

## Versioning

- `v3.<round>` is the snapshot sent to the clinician in that round; `v3.<round>.<rev>` is each PO edit or accepted AI revision within a round.
- Every version is a frozen `pathway.json` in versioned S3 with a hash. Approvals and audit rows point at a version and hash, never at a conversation.

## Clinician feedback (structured)

| Type | Typical AI revision |
|---|---|
| Wording | New question label |
| Threshold or value | New value in the condition |
| Show condition | New `show_if` |
| Wrong source | Re-cite to another guideline block, quote re-verified |
| Remove | Remove the question |
| Add missing question | New question from the note |

Reject requires a type and a note. Notes too vague to act on (short, no value) produce **Needs clarification**, never a guessed change. Accepted AI revisions carry `source: clinician_feedback` (name, round) plus the guideline quote.

## Data model

**`pathway.json`** (single source of truth, one per version):
```json
{
  "version": "v3.2", "hash": "c4e81a2", "guideline": {"s3_key": "...", "sha256": "...", "pages": [4, 5]},
  "questions": [{
    "id": "chest_indrawing", "type": "yes_no", "label": "Is there chest indrawing?",
    "show_if": {"all": [{"field": "cough", "op": "=", "value": "yes"}]},
    "change": "changed", "source": [{"block_id": "p4-t1-r4c2", "quote": "Look for chest indrawing."}]
  }],
  "rules": [{"id": "severe_pneumonia", "when": {"any": ["..."]}, "then": {"classification": "...", "action": "..."}, "source": ["..."]}],
  "flags": [{"id": "a1", "kind": "ambiguity", "about": "...", "quotes": ["..."], "resolution": {"value": "lt", "by": "clinician", "round": 1}}]
}
```

**DynamoDB**
- `Questions`: PK `pathwayId#version`, SK `questionId`. Label, type, show_if, change tag, source, origin (`ai` / PO name / `ai_from_feedback`).
- `Reviews`: PK `pathwayId#round`, SK `questionId`. Decision, feedback type, note, value, clinician, time.
- `Audit` (append-only, never updated): PK `pathwayId`, SK `timestamp#eventId`. Event, actor, version, hash, note.

## Rules the UI must keep (from the brief)

1. The model drafts and proposes; code applies and checks; people approve.
2. Approval binds to one exact version.
3. Ambiguities and cross-check disagreements are shown with their quotes, never resolved silently.
4. Expected test outcomes come from the approved rules in code, never from a model.
5. Content approval (clinician) and deploy approval (IT) are different people.

## Merging notes

- `index.html` is one self-contained file: CSS in `<head>`, screen markup in `<template id="tpl">`, a small renderer, then the `Component` class holding all state and handlers. To merge, copy the screen blocks you need from the template (each starts with an HTML comment such as `<!-- ============ REVIEW ============ -->`) and the matching values from `renderVals()`.
- Table and select tags inside the template are written as `x-table`, `x-tr`, `x-select`, `x-option` and so on; the renderer maps them back. Keep that if you edit the template.
- Text inputs commit on Enter or when you leave the field.
- Colors: ink #1A1D21, muted #4B5360, accent #1F5FAD, added #E6F4EA/#14532D, changed #FFF4D6/#7A4E00, removed #FDECEA/#8E1B12. Fonts: Inter, IBM Plex Mono.
- `design-source/wf/` wireframes are early grey-box drafts and still show the old PM-approval flow. `Main.dc.html` / `index.html` are current.
