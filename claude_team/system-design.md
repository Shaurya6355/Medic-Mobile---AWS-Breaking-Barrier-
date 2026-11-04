# End-to-end system design: No-Code CHT Configuration (Medic, AWS Breaking Barriers 2026)

## 1. Context
- **What this is:** the complete design for the system the team builds on Nov 3-5. It covers every stage, every check, every AI touchpoint, and how each result is explained to a person.
- **What it supersedes:** the earlier "what to build first" plan, now recorded as D-012 and kept as §16 here.
- **Sources:**
  - `Medic Mobile/vision-document-no-code-cht-configuration.md` (MVP criteria, journeys, Well-Architected targets).
  - `Medic Mobile/technical-environment-document-no-code-cht-configuration.md` (10 design rules, services, disallow list, testing rules).
  - CLAUDE.md, D-002 to D-012.
  - The `explore/ingest.py` spike.
- **Assumptions to confirm at the Day 1 design review (D-009):**
  - Open path.
  - Terraform.
  - The approver gets both a visual review and a chat.
- **Reference path:** the same backbone, with the compiler targeting cht-ui-builder's form model (§17).

**Outcome:** a public guideline becomes one CHT pathway that has been reviewed, approved, compiled and tested.
- Every rule can be traced to its source passage.
- Every check is deterministic.
- AI only drafts and cross-checks, and every AI output is validated by code and decided on by a human.

## 2. Principles (each one enforced in code, not by convention)
| # | Principle | Enforced by |
|---|---|---|
| P1 | AI proposes, code decides, humans approve | AI outputs are data and never executed. Pipeline transitions accept only validator results or recorded human decisions. |
| P2 | One source of truth | The **logic model** (§4). The UI, checks, compiler, expected outcomes and explanations all read it through one interpreter. |
| P3 | Everything after the snapshot is reproducible | Canonical JSON, a SHA-256 hash, pinned images, no clock and no network in builds. Two builds of the same snapshot must be byte-identical. |
| P4 | Nothing is resolved silently | Every finding goes to the **issue register** (S6) and needs a recorded disposition before approval. |
| P5 | Separation of duties | The drafter, content approver and deploy approver must be different people, enforced by the API. Clinical changes need the clinician role. |
| P6 | Append-only provenance | Every artifact is kept in versioned S3 with a hash and indexed in DynamoDB. Nothing is overwritten. |
| P7 | Explainable by construction | Plain-language explanations are rendered **deterministically from the AST** and are never written by a model. |

## 3. Architecture

```
            ┌──────────────────────── EC2 #1 (t3.xlarge, Docker Compose) ───────────────────────┐
 Browser ──►│ review-ui (React) ──► api/orchestrator (TS, Fastify) ──► ingest (Python)         │
 (Cognito/  │                        │  ├─ @app/logic (schema, DSL, interpreter, checks)      │
  SSM fwd)  │                        │  ├─ @app/synth (synthetic patients)                    │
            │                        │  ├─ @app/compiler (logic → form spec → xlsx/tasks.js)  │
            │                        │  └─ ai-gateway (only module that calls Bedrock)        │
            │                        └─► one-off build container (cht-app-ide v6.6.1, no net, │
            │                            snapshot mounted read-only, IMDS blocked)             │
            └────────────────────────────────────────────────────────────────────────────────┘
                 │ S3 (versioned, private, KMS)   DynamoDB (runs, approvals, audit, issues)
                 │ Bedrock (Claude via us. profiles, Guardrails, KB over cht-docs)
                 │ Secrets Manager · CloudWatch · Budgets · ECR · SSM
            EC2 #2 (t3.large): CHT test instance via CHT Docker Helper (stretch: upload target)
```

- **Languages (within Medic's allowed list):**
  - TypeScript and Node 22 for the api, logic, synth, compiler, ai-gateway and UI.
  - Python 3.12 for ingest and the xlsx writer (cht-form-builder `generate-xlsform.py`, pinned commit).
- **Runtime:** every service is a container on EC2. There's no Lambda, Fargate, RDS or Step Functions; the approval waits are a DynamoDB state machine (§5).

## 4. Core data model: the logic model (the contract)
`packages/logic/schema/logic-model.schema.json` is the source schema. The Zod types are generated from it, and every component imports them.

```jsonc
{
  "schema_version": 1, "pathway_id": "imci-cough-fast-breathing",
  "source": { "doc_sha256": "...", "doc_name": "...", "pages": [12,13] },
  "variables": [            // typed inputs, each becomes a form question
    { "id": "age_months", "type": "integer", "unit": "months", "range": [0, 59],
      "label": {"en": "Child's age in months"}, "source": ["p12.b4"] },
    { "id": "resp_rate", "type": "integer", "unit": "breaths/min", "range": [0, 150], ... },
    { "id": "chest_indrawing", "type": "boolean", ... },
    { "id": "danger_signs", "type": "select_multiple", "choices": [...], ... }
  ],
  "relevance": { "resp_rate": {"op":"==","var":"has_cough","value":true} },  // when asked
  "tables": [               // decision tables, DMN-style
    { "id": "classify", "hit_policy": "FIRST",          // FIRST (ordered) or UNIQUE
      "rules": [
        { "id": "r1", "when": {"op":"or","args":[{"op":"==","var":"chest_indrawing","value":true}, ...]},
          "then": {"classification": "severe_pneumonia", "actions": ["refer_urgent"]},
          "source": [{"block": "p12.b7", "quote": "Any general danger sign or chest indrawing"}] },
        ...,
        { "id": "r_default", "when": {"op":"true"}, "then": {...}, "source": [...] }  // catch-all required
      ] } ],
  "outcomes": { "classification": ["severe_pneumonia","pneumonia","no_pneumonia"], "actions": [...] },
  "followups": [ { "id": "f1", "if_outcome": "pneumonia", "due_days": 3, "window": [0, 7],
                   "label": {...}, "source": [...] } ],
  "clinical_text": [ { "id": "t_refer", "text": {"en": "..."}, "clinical": true } ]
}
```

- **Conditions use a small JSON DSL, not free text.**
  - Operators: `== != < <= > >= in contains and or not true`.
  - Every `var` must reference a declared variable, and every value must match that variable's type and range.
  - This is what makes analysis, interpretation, XPath generation and parsing back to the DSL possible.
- **One interpreter:** `@app/logic/evaluate(model, inputs) → {outcome, fired_rules, trace}`. It's used by the checks, golden cases, expected outcomes, UI explanations and the cross-check diff. It's never reimplemented anywhere else.
- **Snapshot:**
  - It's the canonical JSON (sorted keys, normalized numbers, UTF-8), then hashed with SHA-256, giving a `snapshot_id`.
  - It's stored at `s3://…/snapshots/<pathway>/<sha>.json`.
  - Edits always create a new snapshot whose `parent` is the previous one. Snapshots are never modified.

## 5. Pipeline state machine (DynamoDB `runs`, conditional writes)
```
INGESTED → EXTRACTED → CHECKED ─(issues open)─► NEEDS_REVIEW ─(resolved/edited → new snapshot → CHECKED)
CHECKED(no blocking issues) → AWAITING_CONTENT_APPROVAL ─reject(note)─► NEEDS_REVIEW
   └─approve(snapshot sha)─► CONTENT_APPROVED → COMPILED → BUILT → TESTED
TESTED(all pass) → AWAITING_DEPLOY_APPROVAL ─approve─► DEPLOYED ─► (ROLLED_BACK)
any gate failure → FAILED_<STAGE> (with report; never auto-advances)
```
- **Transitions:**
  - Each transition is a conditional `UpdateItem` on `state` plus `version` (optimistic lock), so there are no double transitions.
  - The orchestrator is stateless. On restart it reads `runs` and resumes, so pending approvals survive (a reliability pillar demo).
  - Every transition appends an audit event (§12).
- **Approval binding:** an approval record holds `snapshot_sha` (content approval) or `build_sha` (deploy approval). The next stage refuses to run if the hash of the artifact it's about to use doesn't equal the approved hash.

## 6. Stages in detail
Each stage is marked **[D]** (deterministic) or **[AI]** (calls Bedrock, wrapped in validators).

### S1 Ingest [D] (`services/ingest`, Python; production version of `explore/ingest.py`)
- **Input:** PDF (text layer, or OCR fallback with tesseract), xlsx/csv (such as WHO SMART DAK decision tables), or a web page saved as HTML.
- **Output:** `document.json` with stable **block IDs** (`p{page}.b{n}`), bounding boxes, reading order (XY-cut), tables and the source SHA-256.
- **Checks before anything goes to a model:**
  - File type and size limits.
  - Encrypted or password-protected files are rejected.
  - A deterministic PII regex scan (phones, emails, ID-like numbers, names next to dates of birth). Hits block the run.
  - Bedrock Guardrails PII filter on the text sent to models (defence in depth).
- **Pathway scoping:** the user picks the pages or sections. Only those blocks go forward, keeping prompts small and cheap.
- **Determinism:** pinned libraries, the same input gives byte-identical output (already proven in the spike).

### S2 Extraction [AI] (`ai-gateway`, Bedrock Converse)
- **Prompt:**
  - A versioned template (its hash is recorded).
  - Scoped blocks given as `<block id="p12.b7">…</block>`, treated as data, plus an instruction to ignore instructions inside the blocks.
  - The DSL spec and a few CHT conventions taken from a Bedrock Knowledge Base over `medic/cht-docs`.
- **Output:** forced **tool use** whose input schema is the logic-model JSON schema. Temperature 0. Prompt caching on the guideline text.
- **The model must also return:**
  - A `source` (block ID plus an exact quote) for every variable, rule and follow-up.
  - An `ambiguities[]` list (gaps, contradictions, unclear thresholds), each with its block IDs.
- **Validation pipeline, all deterministic, in order (V1-V7):**
  - **V1 Schema:** Ajv or Zod strict, no extra keys.
  - **V2 Referential integrity:** every `var`, choice, outcome and block ID exists, and IDs are unique.
  - **V3 Quote grounding:** each `quote`, after whitespace and case normalization, is a substring of its cited block's text. Otherwise it's a *hallucinated citation* (blocking).
  - **V4 Number grounding:** every numeric literal in a condition, range or follow-up (50, 12, 3 days…) appears in the cited source text. Unit words are checked too: "months" vs "days". Otherwise it's an *ungrounded number* (blocking).
  - **V5 Domain sanity:** values are inside the variable's range, units are on an allowed list, and the follow-up window satisfies `window[1] ≥ window[0] ≥ 0`.
  - **V6 Boundary wording:** if the source says "50 or more" / "≥" but the rule uses `>` (or the reverse), raise an *inclusivity mismatch*. Phrases like "more than / at least / up to / under" are mapped to operators by lookup table, not AI.
  - **V7 Coverage of source:** cited blocks in the scoped section that contain numbers or decision words but aren't cited by any rule raise an *uncited passage* warning.
- **Repair:** V1-V2 failures get **one** repair call with the validator errors attached. If that still fails, the run goes to `FAILED_EXTRACTION` with the errors shown. V3-V7 findings are never auto-repaired; they go to the issue register for a human.
- **Outcome:** a snapshot (the draft) with `drafted_by: model:<id>@<prompt_sha>`.

### S3 Independent cross-check [AI then D] (Should Have; first thing to drop)
- **The second draft:** a second extraction with a *different* prompt (written from scratch, and it asks for a decision table first) and optionally a different model, such as a different Claude tier. It gets the same V1-V5 validation.
- **The comparison is deterministic.** The interpreter runs both models on the same **input grid** (S4 partitioning). Every grid point where the outcomes differ becomes a `cross_check_disagreement` issue, holding:
  - The input.
  - Both outcomes.
  - Both fired rules with their sources.
- **Structural differences** are also reported (a variable present in one but not the other, different thresholds), matched by variable ID or label.
- **The model never decides which draft is right.** The human picks or edits.

### S4 Logic checks [D] (`@app/logic/checks`)
These run on every snapshot, whether AI-drafted or hand-edited (design rule 3).
| Check | Method | Severity |
|---|---|---|
| Schema, references, types | As V1-V2 | blocking |
| Closed tables | The last rule is `true`, or an exhaustive cover is proven by the grid | blocking |
| Completeness | Every grid point gets an outcome | blocking |
| Exclusivity | For `UNIQUE` tables, no grid point fires more than one rule. For `FIRST`, report **shadowed rules** (never first to fire) | blocking / warning |
| Reachability | Every rule fires for at least one grid point. Every question's relevance is satisfiable. Every outcome and follow-up is reachable | blocking |
| Dead inputs | A variable that's asked but never affects any outcome | warning |
| Relevance cycles | The dependency graph of `relevance` must be acyclic | blocking |
| Use before ask | A rule reads a variable whose relevance can be false when the rule is evaluated (missing guard) | blocking |
| Boundary checks | For each threshold t, check that t-1, t and t+1 land in the intended rules, and show them in the UI | info (shown) |
| Follow-up consistency | Every follow-up's `if_outcome` exists. Windows are valid. No two follow-ups fire for the same outcome unless declared | blocking |
| Field names | Stable, XLSForm-safe IDs. Renaming a field that exists in a previously deployed snapshot is **blocked** | blocking |
| Clinical text present | Every referral or danger-sign outcome has clinical text | blocking |

- **Input grid (the partitioning):**
  - Integers: the domain is split at every threshold appearing in any condition; take each interval's endpoints plus t±1.
  - Booleans and choices: enumerate every value.
  - Absent (non-relevant) is its own value.
- **Grid size:** the Cartesian product is fine for one pathway (~10 variables). If it's over 50k points, switch to pairwise plus all rule-satisfying points and record that in the report.
- **Optional stretch:** `z3-solver` (Python, MIT) proves satisfiability and overlap symbolically for larger tables.

### S5 Golden cases [D]
- `fixtures/<pathway>/golden-cases.json` holds about 12 cases written by humans from the guideline's worked examples. Each case has inputs, expected outcome, a source block and an author. Medic confirms them in the clinician's role.
- They run through the interpreter. Any mismatch becomes a blocking issue showing the expected vs actual outcome and the fired-rule trace. A blocking issue can be cleared by fixing the logic, or by explicitly accepting it with a recorded note, so the mismatch is "shown before approval".
- **Golden cases are never generated by AI.** The UI shows who wrote each case.

### S6 Issue register and risk routing [D]
- **Issue sources:** extraction ambiguities [AI], V3-V7, cross-check, logic checks and golden cases, all stored in the same `issues` table.
- **Each issue records:** source passage, severity, the rule or variable IDs involved, and status. Dispositions are `edited` (links a new snapshot), `accepted_with_note`, or `escalated_to_clinician`.
- **The approve button is disabled server-side** while any blocking issue is open.
- **Risk classification** is a deterministic diff against the parent approved snapshot:
  - **Clinical, needs the clinician role:** a change to variables, conditions, thresholds, hit policy, outcomes, follow-ups, relevance, or clinical text.
  - **Wording, program reviewer can approve:** labels only, and the reviewer can escalate.
  - **Blocked:** a field rename on a deployed form.
  - A brand-new pathway is always clinical.

### S7 Content approval [human]
- **The approver sees** (§8):
  - The rendered decision table and flowchart.
  - Plain-language rules with source quotes.
  - Issues and their dispositions.
  - Golden-case and grid results.
  - The logic diff against the parent.
- **The decision is recorded:** `{snapshot_sha, decision, role, user, note, ts}`. The approver can't be the drafter, and a model-drafted snapshot is attributed to the person who ran extraction.
- **A preview build** (S8 and S9, marked `preview`, never deployable) may run first to give the approver test evidence.

### S8 Compile [D] (`@app/compiler`)
- **Input:** the approved snapshot only. The compiler checks `sha(snapshot) == approval.snapshot_sha`.
- **Output:**
  - `forms/app/<pathway>.xlsx` (survey, choices, settings).
  - `<pathway>.properties.json`.
  - `tasks.js` entries for follow-ups.
  - `translations/messages-en.properties`.
  - These are copied into a base CHT project (a pinned copy of `cht-core/config/default`, or a minimal project).
- **Mapping rules (fixed and unit-tested):**
  - variable → question row (type, label, constraint from the range, required).
  - relevance AST → XPath `relevant`.
  - decision table → nested `if()` calculate fields giving `classification` and `actions` (FIRST order kept).
  - follow-up → a calculate field for the due date plus a `tasks.js` task with `appliesTo: 'reports'`, `appliesToType: [form]`, `appliesIf` on the classification field, `events: [{dueDate, start, end}]` and `resolvedIf`.
- **Determinism:**
  - Rows are emitted in schema order, and names are derived from IDs.
  - Workbook metadata is fixed (no created/modified time); zip entry timestamps are fixed when writing the xlsx.
  - `tasks.js` comes from a template with sorted keys.
- **Source map:** `sourcemap.json` maps each xlsx row and tasks.js task → rule or variable ID → guideline block ID. It's the backbone of explainability.
- **Round-trip check:**
  - The compiled xlsx is read back (`read-xlsform.py` from cht-ai-tools, or our openpyxl reader).
  - Our XPath subset is parsed back into the DSL AST.
  - It must equal the snapshot's AST. Otherwise it's a blocking compile error.
  - This proves the compiler kept the logic, which is the bracket-bug class of error.

### S9 Release build [D] (one-off container)
- **The container:**
  - It's `build-image/` (FROM `medicmobile/cht-app-ide:v6.6.1`, with the harness, its npm packages and Chromium baked in).
  - It runs as non-root with the `SYS_ADMIN` capability only, `--network none` and the IMDS endpoint blocked.
  - The snapshot and compiled files are mounted read-only, and the output goes to a fresh folder.
- **Steps:**
  - `cht --no-check validate-app-forms convert-app-forms compile-app-settings`. Any failure is a **hard gate**.
  - Build twice and compare the artifact hashes. A mismatch is a determinism failure (blocking).
  - Tar the artifacts, giving `build_sha`, stored in S3 with the cht-conf and image versions.

### S10 Synthetic-patient verification [D] (`@app/synth` + cht-conf-test-harness)
- **Generating patients:**
  - One patient per rule (the **branch**). Inputs are chosen by solving its `when` against the grid, and earlier rules must *not* fire (FIRST policy).
  - Plus **boundary patients** at each threshold t-1, t, t+1.
  - Plus every golden case.
  - Plus non-relevant-path patients (questions skipped).
- **Expected outcome** = `evaluate(approved_snapshot, inputs)`. Never a model (design rule 6).
- **Running them:** generated mocha specs drive the harness. For each patient the spec:
  - Fills the compiled form.
  - Asserts the report's `classification` and `actions` fields equal the expected values.
  - Advances the harness clock and asserts the follow-up task appears on day `due_days` and disappears after the window or when resolved.
- **Report:** per patient, the inputs, expected and actual outcome, the fired rules with sources, and pass or fail. **Branch coverage** is the number of branches with at least one passing patient over all branches, and must be 100%. Any mismatch blocks.
- **Differential check (edits):**
  - The same patient set, plus the parent's patients, runs through the parent build and the new build.
  - Changed outcomes are listed, and the change must match the risk class: wording-only edits must show **zero** changed outcomes.
  - This is the exact check that caught Medic's dropped-brackets bug.
- **Self-test of the tester:** a mutation step builds a copy with one condition mutated (drop parentheses, flip `>`/`>=`). The suite **must fail** on it, which proves the tests have teeth (shown in the report).

### S11 Deploy approval [human]
- **Shown:**
  - The file diff (xlsx rendered as a table diff, tasks.js text diff) against the last deployed build.
  - The logic diff in clinical terms.
  - The test and coverage report, the differential report, and the content approval record.
- **Recorded:** `{build_sha, snapshot_sha, user (≠ content approver), role: it_lead}`.

### S12 Deploy and post-deploy check [D] (stretch)
- `cht --url=$CHT_URL upload-app-forms upload-app-settings`, with credentials from Secrets Manager. Never `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Post-deploy check:** fetch the served `app_settings` and form attachments from the instance and compare their hashes to the build. A mismatch triggers a rollback.
- **Seeding:** test-data-generator with a small design for this pathway's contacts and reports, so the form and tasks show up in the CHT app.

### S13 Rollback [D]
- Redeploy any earlier `build_sha` that has a deploy approval (the artifacts are in S3).
- This is recorded as an audit event, and the run state becomes `ROLLED_BACK`.
- **Revert = new snapshot whose content equals an older one.** It goes through the same gates, but its approval can reference the earlier one.

## 7. Explainability (what a person can always ask, and how it's answered, all deterministically)
| Question | Answer source |
|---|---|
| Where did this rule come from? | Rule → `source[]` → block → page and bounding box. The UI highlights the passage on the rendered page. |
| What does this rule mean? | AST → plain-language renderer, such as "If age is 2-11 months **and** breathing rate is **50 or more** per minute → Pneumonia; refer…". Deterministic templates, never AI. |
| Why did this patient get this outcome? | Interpreter `trace`: variables read, rules evaluated in order, first rule that fired and its source. |
| What did this change do? | Logic diff (added, removed or changed rules in plain language) plus the differential outcome list. |
| Which spreadsheet cell or JS line implements this rule? | `sourcemap.json`. |
| Who drafted, checked, approved, built, tested and deployed this? | The audit chain for a `snapshot_sha` or `build_sha`. |
| What did the AI do here? | The AI call record: model, prompt version, input hash, output, validator results, tokens, cost. Shown with an "AI-drafted" badge on every AI-originated rule until a human edits or accepts it. |

**Chat (optional, AI):**
- It answers questions using the logic model and the guideline blocks given as context.
- Every claim must cite rule or block IDs, and code checks they exist (V2 and V3 rules). If a citation fails, the answer is withheld.
- Answers are labelled "AI explanation, not approval evidence".
- Change requests come back as a structured **edit proposal** (JSON patch on the logic model). Code applies the patch, makes a new snapshot and reruns S4-S6, and the human approves the snapshot, not the chat (design rule 4).

## 8. Approver experience (review-ui)
1. **Upload and scope:** upload a file, see the page thumbnails, pick the pages for the pathway.
2. **Draft review:**
   - Split view: decision table or flowchart (React Flow, generated from the AST) on the left, the guideline page with highlighted source on the right.
   - Each rule card shows the plain-language rule, quote, badges (AI-drafted, edited, issue) and boundary examples.
3. **Issues panel:** each issue with its passage, a disposition picker and a mandatory note; blocking issues are counted.
4. **Tests panel:** golden cases, grid summary, branch coverage, and the cross-check disagreements.
5. **Edit:** a form-based editor over the DSL (no code), or a chat proposal. Every save makes a new snapshot and reruns the checks.
6. **Approve or reject:** role check, separation-of-duties check, then the snapshot hash shown and the confirmation recorded.
7. **Deploy review:** diffs, test report, differential, approve.
8. **History:** snapshot lineage, audit timeline, rollback.

- **Sign-in:** Cognito users with groups `drafter`, `program_reviewer`, `clinician`, `it_lead`. For the demo, the UI is reached through SSM port forwarding, or an ALB plus Cognito if time allows.

## 9. AI governance (ai-gateway, the only code that calls Bedrock)
- **Model registry** `config/models.json`:
  - Fields: task → model ID (`us.` inference profile), parameters, prompt template path and its hash, max tokens.
  - Changing a model is a config change only (cost-pillar requirement).
- **Every call is logged** to S3 and DynamoDB `ai_calls` with: prompt hash, input block IDs, output, validator verdicts, tokens in and out, cached tokens, latency and cost (priced from a rates table). The **cost per pathway run** is summed for the README.
- **Controls:**
  - Temperature 0.
  - Structured output via tool use.
  - Guardrails (PII; denied topics such as medication dosing outside the source).
  - Prompt-injection hardening: content is delimited and treated as data, and outputs are never executed.
  - Timeouts and retry with backoff for throttling only.
  - A per-run token budget, with a hard stop when exceeded.
- **What AI is never allowed to do:**
  - Write xlsx or JS.
  - Pick between disagreeing drafts.
  - Judge a test.
  - Write golden cases.
  - Move the state machine. The ai-gateway has no permission on the `runs` or `approvals` tables.
- **Extraction eval (dev-time, deterministic):** score a draft against the hand-written fixture using:
  - Variable and rule precision and recall, matched by ID or label.
  - Grid outcome agreement %.
  - V3 and V4 failure counts.
  - Results are tracked per prompt version in `evals/`. This is how prompts and models are chosen, and it's reported in the README.
- **Reproducibility of AI steps:** AI output isn't guaranteed to be deterministic, so the **snapshot is the reproducibility boundary**. The raw AI output is stored, and everything downstream of an approved snapshot is deterministic and re-runnable.

## 10. AWS infrastructure (Terraform, `infra/`)
| Resource | Notes |
|---|---|
| VPC | Private subnets plus VPC endpoints (S3, DynamoDB, Bedrock runtime, SSM, ECR, Logs, Secrets); NAT only for image pulls on Day 1 |
| EC2 #1 | t3.xlarge, Ubuntu, x86_64, IMDSv2 with hop limit 2, encrypted EBS, user data installs Docker and pulls from ECR. No SSH; SSM only |
| EC2 #2 | t3.large for the CHT instance (Docker Helper) |
| ECR | Repos: api, ui, ingest, build-image (immutable tags) |
| S3 | `guidelines`, `snapshots`, `artifacts`, `audit`, `ai-calls`: private, versioned, SSE-KMS, block public access. Object Lock (governance mode) on `audit` |
| DynamoDB | Tables `runs`, `snapshots`, `issues`, `approvals`, `audit_index`, `ai_calls`, on-demand, encrypted, PITR on |
| Bedrock | Model access via IAM restricted to the named inference profiles; Guardrail; Knowledge Base (S3 source: cht-docs Markdown; vector store choice settled on Day 1) |
| Cognito | User pool plus four groups |
| Secrets Manager | CHT instance credentials |
| CloudWatch | `awslogs` driver for every container, metric filters (gate failures, Bedrock errors), alarms |
| Budgets | $250 and $400 alerts, project tag filter |
| IAM | Instance role scoped per need; the build container is blocked from IMDS; the ai-gateway's permissions are separate (with Compose, use separate instance-profile credentials via ECS-style task roles if time allows, otherwise iptables plus a scoped role) |

- **Tagging:** every resource gets `project=nocode-cht`.
- **Deploy and teardown:** `make deploy` / `make destroy`. Account, region and model IDs are variables, and no ARN is hard-coded.

## 11. Repository layout (pnpm monorepo + Python service)
```
packages/logic/      schema, DSL, interpreter, grid, checks, renderer (plain language), diff
packages/synth/      patient generation, harness spec generation
packages/compiler/   logic → form spec → xlsx (+ writer adapter), tasks.js, sourcemap, round-trip
services/api/        Fastify orchestrator, state machine, approvals, RBAC, audit
services/ai-gateway/ (module inside api, or separate container) Bedrock calls, validators V1–V7
services/ingest/     Python ingest (PDF/xlsx/csv/OCR), PII scan
services/review-ui/  React + React Flow
build-image/         Dockerfile FROM cht-app-ide:v6.6.1 + harness + Chromium baked
base-project/        pinned minimal CHT project the compiler writes into
fixtures/<pathway>/  guideline, hand-written logic, golden cases
evals/               extraction eval runs
infra/               Terraform
docs/                architecture, Well-Architected mapping, runbook, cost report
```

## 12. Audit and provenance
- **Event shape:** `{event_id, ts, actor (user or model:<id>), action, subject_sha, prev_event_sha}`. The events are hash-chained and form a tamper-evident log.
- **Storage:** written to S3 `audit/` (Object Lock) and indexed in `audit_index`.
- **Events recorded:**
  - Upload, ingest, every AI call.
  - Every snapshot, check run and issue disposition.
  - Approvals, builds, test reports, deploys and rollbacks.
- **"One change's record, end to end"** (the operational excellence demo) is a query by `snapshot_sha` that renders this chain.

## 13. Security
- Only synthetic or public data; the PII scan plus Guardrails run before any model call.
- Cognito sign-in on every endpoint; RBAC plus separation of duties enforced server-side.
- No long-lived keys; SSM instead of SSH; IMDSv2.
- Build containers have no network, no credentials, no Docker socket, and no capability except `SYS_ADMIN`.
- Model calls stay in the account (Bedrock only; the cht-docs MCP is used at dev time only, never at runtime).
- No secrets in the repo. Pre-commit `gitleaks`; `.gitignore` for `.env`, `out/` and `.venv`.

## 14. Testing our own system (deterministic, CI with GitHub Actions)
- **Unit tests:**
  - DSL type checks, the interpreter, each logic check (one fixture that triggers each check plus one that passes).
  - XPath emitter and parser round trip.
  - Plain-language renderer snapshots.
- **Property tests** (fast-check):
  - Random ASTs survive the XPath round trip unchanged.
  - The interpreter agrees with the compiled XPath when evaluated by the harness on sampled grid points.
  - Canonical hashing is stable when keys are reordered.
- **Validator tests:** fake AI outputs with a hallucinated quote, an ungrounded number, a flipped inclusivity, a missing catch-all; each must be caught.
- **Mutation test:** the dropped-bracket bug reproduced on the fixture must be caught by the differential and the harness.
- **Determinism tests:** ingest twice, compile twice and build twice, each compared by hash.
- **Restart test:** kill the api container while a run is `AWAITING_CONTENT_APPROVAL`, restart it, approve, and the run continues.
- **Golden fixture end to end:** hand-written logic → all gates green, in CI (using a recorded Bedrock response; no live model in CI).

## 15. Well-Architected mapping (goes in the README with evidence links)
- **Operational excellence:** IaC, `make deploy` / `make destroy`, pinned images, CloudWatch, the audit chain for one change, the eval and cost report.
- **Security:** §13, the two approvals bound to hashes, separation of duties.
- **Reliability:** the DynamoDB state machine survives a restart; cht-conf is a hard gate; the round trip and double build; rollback to any approved build.
- **Performance efficiency:** deterministic code everywhere except drafting and cross-checking; page scoping; prompt caching; timed steps in the run record.
- **Cost:** budgets, model registry swap, cost per run, instances stopped outside build hours, teardown.
- **Sustainability:** no training; compute only when building; phones get standard offline configuration.

## 16. Build order and ownership (D-012, refined)
| When | Step | Owner |
|---|---|---|
| D1 AM | Setup and warm-up (EC2, cht-app-ide, Docker Helper, reference config tests, budgets) | all |
| D1 late AM | Pathway choice, `logic-model.schema.json` + Zod + DSL, hand-written fixture, golden cases | lead + clinician-role person |
| D1 PM | **Riskiest spike:** compiler → cht-conf → one harness patient | compiler/ |
| D1 PM | Interpreter, grid, logic checks, golden runner | checks/ (packages/logic) |
| D1 PM | Terraform skeleton, ECR, S3 and DynamoDB, state machine and approvals API | infra/ + api/ |
| D2 AM | Ingest service, Bedrock extraction plus V1-V7, issue register, eval against the fixture | extraction/ |
| D2 AM | Synth plus harness spec generation, coverage, differential, mutation self-test | checks/ |
| D2 PM | Review UI (draft review, issues, approve, deploy review), audit view | review-ui/ |
| D2 PM | Cross-check (drop first if late), chat (drop second), deploy and seed (stretch) | extraction/ |
| D2 eve | README, Well-Architected table, cost per run, deploy from a fresh account | lead |
| D3 AM | Timed demo rehearsal against the MVP checklist | all |

- **Drop order if late:** S12 deploy → chat → S3 cross-check → z3. Never drop: the checks, golden cases, approvals, compile gate, synthetic tests.

## 17. Reference path variant (if chosen)
- The compiler targets cht-ui-builder's `XLSForm` model, and `serializeXlsForm` writes the files.
- Approval actions are added to its decision table and logic graph view. Fix the known inverted task-condition display first.
- Edit requests become structured proposals that the editor applies, shown with a diff.
- The differential check (S10) is the before/after check.
- Its existing tests must keep passing, and opening then saving with no edits must change nothing.
- Every other part (logic model, checks, AI governance, approvals, audit) is the same.

## 18. Demo script, mapped to the MVP criteria
1. Upload the guideline and scope the pages → draft appears with sources (criterion 1).
2. The issue register shows an ambiguity and an inclusivity mismatch with their passages (criterion 2).
3. The logic checks catch a seeded gap; it's fixed in the editor and a new snapshot is made (criterion 3).
4. The golden cases show one mismatch before approval (criterion 7).
5. The clinician role rejects once with a note, then approves; the hash is shown (criterion 4).
6. The compile → cht-conf build passes (criterion 5).
7. Synthetic patients reach 100% branch coverage and all match; the mutation self-test fails as it should (criterion 6).
8. Deploy approval by a different user, plus the audit chain for this change.
9. Restart during an approval wait; then a rollback.
10. Cost per run and spend to date.

## 19. Open decisions (Day 1 design review)
- **Track (D-009):** Open path assumed.
- **IaC (D-009):** Terraform recommended.
- **Pathway and guideline:** default is WHO IMCI cough or difficult breathing.
- **xlsx writer:** cht-form-builder `generate-xlsform.py` vs our own openpyxl writer; decide after the D1 PM spike.
- **Vector store for the Knowledge Base:** cheapest option that's allowed; or skip the KB and paste a fixed CHT-conventions primer into the prompt.
- **Approver UI scope:** visual plus chat, or visual only.

## 20. Verification of this design (how we'll know it works)
- CI runs: unit, property, validator, mutation, determinism and restart tests; plus the golden fixture end to end with a recorded AI response.
- A live run on a fresh sandbox follows the §18 script with the timer on, and every MVP checkbox in the vision doc is ticked by the Medic rep.
- `make destroy` leaves no tagged resources (checked with Resource Groups Tagging API).

## 21. Status
- Design only. Per D-002, no solution code before Nov 3. Recorded as D-013 in `DECISIONS.md`.
