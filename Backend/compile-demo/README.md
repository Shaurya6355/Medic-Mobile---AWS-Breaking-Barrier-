# Compile demo

First end-to-end run of the CHT compiler: the team's logic model fixture
(`Backend/tests/fixtures/logic/v1.json`, DEC-017; the root `v1.json` is never read or edited) is
compiled by `src/compiler/compileSnapshot.ts` into a CHT project, then the real cht-conf compiles and
validates that project. Synthetic data only.

## Run

```
cd Backend
npm ci
npm run compile:demo      # tsx compile-demo/run.mjs; exit code 0 only if every step passes
npm run compile:demo -- --flow=danger_signs_always   # or --flow=minimal (default) / --flow=full
```

`--flow` overrides `flowMode` from `settings.demo.json` (default `minimal`). See "Question flow" below.

Then open:

- `compile-demo/output/REPORT.md`: manifest, survey and choices sheets, tasks.js, properties.json,
  cht-conf step results with log excerpts, warnings, not-compiled items, determinism, what is not verified.
- `compile-demo/output/survey.html`: the survey rows in a browser.
- `compile-demo/output/flow.md` and `flow.html`: the derived question flow for `minimal` and `danger_signs_always`,
  as a Mermaid diagram plus plain sentences grouped by outcome, and the questions asked per golden case.
  `flow.html` renders the diagrams offline (the mermaid browser bundle is copied next to it as `mermaid.min.js`
  from `compile-demo/preview/node_modules`).
- `compile-demo/output/project/`: the generated CHT project, including the source
  `forms/app/cough_fast_breathing.xlsx` and, from cht-conf, `forms/app/cough_fast_breathing.xml` and `app_settings.json`.
- `compile-demo/output/logs/*.log`: full stdout/stderr of each cht-conf step.
- `compile-demo/output/manifest.json`, `run-result.json`: machine-readable results.

The output folder is regenerated on every run (it is deleted first). The only exception is `output/verify-modes/`,
which holds the latest compile:verify summary for each flow mode.

## Prerequisites

- Node 22+ (the Backend dev dependencies, including tsx).
- cht-conf 6.6.1, pinned in `compile-demo/tools/package.json`. `run.mjs` runs `npm install` there if it
  is missing (network needed once). `tools/node_modules` is git-ignored.
- A Python 3.10 to 3.13 interpreter. cht-conf converts xlsx with `bin/xls2xform-medic`, a Python zipapp
  (CHT's pyxform fork, bundled, so no pip install is needed). It does NOT run on Python 3.15
  (`ValueError: Cannot use capturing groups in re.Scanner`, raised inside the bundled pyxform).

### How Python is chosen (least invasive)

`run.mjs` (through `chtConf.ts`, the cht-conf driver shared with `scripts/compileLocked.ts` and `npm run pipeline:demo`) probes, in order, `$CHT_PYTHON` (if set), `python3`, `python3.13`, `python3.12`, `python3.11`,
`python3.10` by actually converting the generated xlsx with the zipapp, and takes the first that works.
On the development machine that is Homebrew's `/opt/homebrew/bin/python3.13` (3.13.5, already installed;
nothing was installed). The zipapp's shebang is `#!/usr/bin/env python3`, so the script creates
`compile-demo/tools/.pyshim/python3` (a symlink to the chosen interpreter, git-ignored) and puts that
folder first on PATH for the cht-conf child processes only. No system setting, global PATH or cht-conf
file is changed. To force an interpreter: `CHT_PYTHON=/path/to/python3.12 npm run compile:demo`.

### Paths with spaces

cht-conf 6.6.1 runs its own `bin/xls2xform-medic` through `/bin/sh` without quoting that path (it only
escapes the form paths). This repo lives under `vs code/`, so the call breaks with
`/bin/sh: ~/vs: No such file or directory`. When the tools path contains whitespace, `chtConf.ts` reaches
cht-conf through a whitespace-free symlink in the OS temp dir and starts node with
`--preserve-symlinks --preserve-symlinks-main`, so cht-conf sees the symlinked path. Removed at the end of the run.

## What it runs

1. `parseModel` on the fixture, then `compileSnapshot(model, { buildKind: "preview", settings })` into
   `output/project/`, with `settings.demo.json` (demo placeholders: title, icon, 7-day task window used
   because open question Q5 is unanswered, contact type person, flowMode). compileSnapshot derives the
   question flow and checks it with verifyFlow on all 6400 grid points before writing anything; it refuses
   on any mismatch. Then `flow.md` and `flow.html` are written.
2. A second compile into a temp folder, comparing the sha256 of every generated file and the sheet
   contents of the xlsx (determinism).
3. cht-conf, with `--source=<project> --skip-dependency-check --skip-version-check --skip-git-check`
   and no `--local`/`--url` (no CouchDB or CHT instance needed), in this order:
   `convert-app-forms` (xlsx to XForm), `validate-app-forms` (reads the XForm, so it must come after
   convert, as in cht-conf's own default order), `compile-app-settings` (tasks.js, targets.js, contact
   summary and base settings to app_settings.json, with eslint and the declarative task schema check).
4. The two validations cht-conf skips without an instance but that only need a version number
   (deprecated-appearance, deprecated-tel-type), run directly against the XForm with apiVersion 5.3.0
   (assumed: the local cht-core checkout version).

## What it proves

- The compiler's output is a CHT project the real cht-conf accepts: the xlsx converts to an XForm,
  the XForm passes has-instance-id, no-required-notes, check-xpaths-exist, db-doc-ref and the other
  offline validations, and tasks/targets/contact summary compile into app_settings.json.
- The compile is deterministic byte for byte.

## What it does not prove (on its own)

- compile:demo alone does not fill the form or check the emitted XPath; the preview and verification
  below do (see "See and verify the form").
- No round-trip parse-back. can-generate-xform (CHT API validation) is not run.
- Not approved, not signed, not deployable: preview build. The demo settings are placeholders.

## See and verify the form (preview tooling)

Run after `npm run compile:demo` (which deletes and regenerates `output/`, so re-run these after it):

```
cd Backend
npm run compile:preview      # builds output/preview/ from the current output/ and serves it: http://localhost:5199/
npm run compile:screenshots  # builds, then writes output/screenshots/*.png (headless Chrome)
npm run compile:verify       # golden cases + differential grid; writes output/VERIFY.md, verify-result.json, a REPORT.md section
npm run compile:verify -- --mutation-check   # also plants known bugs (and equivalent mutants) in a temp copy of the XForm and checks the grid catches each
```

compile:verify checks the form that compile:demo built last, in its flow mode (read from `output/manifest.json`).
To verify another mode: `npm run compile:demo -- --flow=danger_signs_always && npm run compile:verify`.
VERIFY.md has a table with the latest result for each mode verified so far (from `output/verify-modes/`).
Development aids, never reported as PASS: `--grid-limit=N` (sample about N grid points) and `--no-partial`.

compile:verify takes about 5 minutes (12,800 fresh enketo forms in one headless Chrome page); with
--mutation-check about 15 minutes. Exit code 0 only if everything passes.

`output/preview/index.html` is a static copy: it also opens by double-click (file://), no server needed.
`PREVIEW_PORT=xxxx` changes the port.

What the preview is: the cht-conf XForm (`output/project/forms/app/cough_fast_breathing.xml`) turned into
enketo HTML + model by `xsltproc` with cht-core's own XSL (`api/src/xsl/openrosa2html5form.xsl`,
`api/src/enketo-transformer/xsl/openrosa2xmlmodel.xsl`) and cht-core's customizeHtml step (markdown via
cht-core's `markdown.js`), exactly as the cht-core api does; then rendered with enketo-core 7.2.5 and
openrosa-xpath-evaluator 2.0.13 (the versions in cht-core 5.3.0's webapp lock file), with the webapp's
enketo config (excludeNonRelevant, validatePage), its enketo-core widget list, its XPath binding and its
enketo-core patch (/inputs always relevant, applied at bundle time). The form opens as if launched
from a contact profile, with a synthetic contact. It shows one question per screen (one page per top-level group) with CHT-style
Previous/Next/Submit, relevance, constraint messages, outcome and dose notes, and a side panel labelled
"Preview tooling, not part of the form" with fast_breathing, danger_sign, outcome and the live model XML.
A red banner marks it as a preview build.

Prerequisites (preview): Node 22+; `xsltproc` (ships with macOS; `apt install xsltproc` on Linux); a
cht-core checkout for the XSL and markdown.js, found at `../../AWS Breaking Barrier - 2026/Medic Mobile/repos/cht-core`
relative to the repo or via `CHT_CORE_DIR` (nothing in it is modified or copied into this repo); Google
Chrome (or `CHROME_PATH`, e.g. a Chromium from `npx playwright install chromium`) for screenshots and
verify. The preview has its own `compile-demo/preview/package.json`; its `node_modules` is installed on
first use (network once) and git-ignored. All preview code lives in `compile-demo/preview/`. It also pins
mermaid 12.3.0, whose browser bundle compile:demo copies next to `output/flow.html` (compile:demo installs the
preview dependencies if it is missing).

What verify proves:
- Golden cases. Each case is typed into the real form inputs, one screen at a time, with the real Next
  pressed on every screen, and the form is submitted. Every case gives the expected outcome and the right
  outcome and dose notes. Only the screens that appear are answered. The case's answers to questions the
  flow skips are never typed. The visible screen sequence must equal the sequence the flow asks for that case.
- Edit scenarios. Answers are changed after the fact, so hidden questions keep stale values. The form is
  then walked again from the first screen, because an edit can bring back skipped screens. The result
  agrees with the interpreter on the full final answers.
- Differential grid. Every point of the exact answer grid (`enumerateAnswers(model)`) gets a fresh form
  with ALL answers set, including those of hidden questions. Enketo treats hidden questions as blank, as
  CHT does. The compiled form's outcome and result notes equal `evaluate()` on the full answers, so the
  short form gives the outcome of answering everything. fast_breathing and danger_sign equal `evaluate()`
  on the shown answers. The questions enketo shows equal the flow's sequence.
- That is the check for build-stage logic bugs. The mutation self-check shows it fails when such a bug is
  planted in the XForm: an off-by-one boundary, a wrong band edge, rule order, an `is_no` emitted with the
  wrong value, or an off-by-one threshold in a flow condition. Equivalent mutants (they change the XPath but
  no answer) must not be flagged. One is the R1/R3 swap under the minimal flow: the swap only matters for an
  out-of-range child with a danger sign, and the minimal flow asks such a child no danger-sign question.
  That is the Q2 hazard made visible.

Found by the preview (fixed in `src/compiler`, test first): the compiled form had no `style: pages`
setting, so pyxform emitted `<h:body>` without `class="pages"` and enketo/CHT would show the whole form
as one long scrolling page instead of one page per group (every CHT default app form has it). The
settings sheet now carries `style = pages`.

## One question per screen

The settings sheet has `style = pages`, which makes enketo (and the CHT webapp) show one page per
top-level group. The compiler therefore wraps every question in its own top-level, unlabelled
`field-list` group named `q_<id>` (so only the question text shows), in the model's question order,
between the CHT `inputs` group and the final `results` group. The group carries the question's
`relevant`, so a question whose `shown_when` is false has no page (enketo drops the page of a
non-relevant group); the question row keeps its own `relevant`, `required`, constraint and message
unchanged. The hidden calculates (patient ids, derived values, `outcome`) stay at the top level, outside
any group, so they add no empty pages. Pages for a fast-breathing child (cough yes): age, cough, cough
days, convulsions, not able to drink or feed, vomits everything, chest indrawing, breaths per minute,
unusually sleepy, Result. With cough = no: the cough days and breaths screens are skipped. The data
path of each answer is now `/data/q_<id>/<id>` (was `/data/assessment/<id>`); the compiled logic is
otherwise identical. The screenshots `02` to `06` show consecutive screens and the skip case.

## Question flow (flowMode)

By default the form asks only the questions that can still change the outcome: the smarter flow that
`deriveFlow` (src/logic/flow.ts) computes from the rule table. A 1-month-old gets the age screen and
then the Result. A child with cough and convulsions = yes gets age, cough, cough days, convulsions,
chest indrawing and breaths, then the Result. The drink/feed, vomiting and sleepy screens are skipped
because they can no longer change the outcome.

The flow is not part of the signed logic model. It is derived from the model at compile time,
deterministically, and anyone can rebuild it from modelSha, the flow mode and the flow derivation version
(all recorded in the manifest and the project README). Its conditions add one flow-only atom, `is_no`
(true only for an answered no; a blank answer is never no), and the constant `never`. They compile to
`${f} = 'no'` and `false()`; `not()` is never emitted. The model's vocabulary is unchanged. Each
question row and its page group carry the authored shown_when AND the flow condition, so skipped
screens disappear. compileSnapshot checks the flow on all 6400 grid points before writing (same outcome
as answering everything) and refuses on any mismatch.

| flowMode | what is asked | average questions (6400-point grid) |
| --- | --- | --- |
| `minimal` (default) | only questions that can still change the outcome | 3.19 |
| `danger_signs_always` | as minimal, plus every danger-sign question always | 8.20 |
| `full` | every question its authored shown_when allows (the earlier behaviour) | 8.92 |

Per golden case, see `output/flow.md`. The grid weights every answer combination equally, and half of
them have an out-of-range age, so these averages do not describe real patients.

**Clinician's choice, said plainly:** the minimal flow never asks danger-sign questions of a child
outside the 2 to 59 month range. The outcome is already decided (refer: outside the age range), so a
1-month-old with convulsions is referred without anyone being asked about convulsions. That is open
question Q2's hazard, and the minimal flow makes it silent. `danger_signs_always` exists for exactly this
reason: it asks every danger-sign question in every case and gives the same outcomes. Which one to deploy
is a clinical decision, not a technical one. Screenshots `12` to `14` show the shortened flow, and `15`
and `16` show flow.html.

What it does not prove: CHT's own widgets (contact selector) and medic XPath extensions, offline/PouchDB
behaviour, the saved CouchDB doc shape, tasks.js and targets behaviour (needs cht-conf-test-harness), the
contact/patient linkage, real devices, and clinical correctness (the golden file is a proposal awaiting
Medic and the interpreter is the reference). See `output/VERIFY.md`.
