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
| Program officer (PO) | Add guideline files, pick pages, create the workflow draft, edit questions, accept/edit/discard AI revisions, send and resend to the clinician | Approve content or deploy |
| Clinician | Approve or reject each question with structured feedback, resolve flags, return to PO, approve all | Edit questions directly, deploy |
| IT approver | Approve deploy after the synthetic patient check | Approve content |

No single person drafts, approves and deploys (brief, design rule 2).

## End-to-end flow

1. **Guidelines.** PO clicks **Add files…** (standard file dialog with a *Files of type* filter), selects a file, picks a pathway and pages, clicks **Create workflow draft**.
2. **Extraction (system).** Index pages (Textract; images via the model) → two Bedrock passes (inputs, then rules) with verbatim quotes → quote and number checks → cross-check pass → logic checks and golden cases. Output: `pathway.json` draft `v3.1`.
3. **PO workflow.** PO reviews every question (change tag, condition, guideline quote), edits if needed, **Send to clinician**.
4. **Clinician review (round N).** Per changed/added/removed question: **Approve**, or **Reject with feedback** (type + note + optional new value). Resolve flags. Then **Return to PO with feedback** (if any rejected) or **Approve all** (all approved, flags resolved).
5. **AI revision (system).** For each rejected question, Bedrock turns the feedback into a structured change, or returns *needs clarification* if the feedback is vague. Code re-runs all checks on the proposed change.
6. **PO revise.** PO sees feedback plus the AI suggestion card: **Accept**, **Edit before accepting**, or **Discard**. Nothing applies until accepted. **Resend to clinician (round N+1)** unlocks when every rejected question is resolved. Loop back to step 4.
7. **Verify.** After clinician approval: build the form, then run synthetic patients through (a) the approved rules in code and (b) the filled form via cht-conf-test-harness. All must match; any mismatch returns to the PO.
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
