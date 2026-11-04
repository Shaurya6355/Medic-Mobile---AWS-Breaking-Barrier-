# Logic model: child cough and fast breathing

Medic No-Code CHT Configuration, AWS Breaking Barriers 2026. Open path.

## What this is

The logic model is the guideline's decision-making, written as data. One JSON file per version. Everything else is generated from it: the review table, the flowchart, the XLSForm, `tasks.js`, and the expected test outcomes.

Source guideline: WHO/UNICEF, *Caring for the sick child in the community*, Chart booklet, adaptation for high HIV or TB settings (July 2014). All page numbers refer to this booklet.

Full spec (the agreed definition, hit policy, signatures and a review checklist): https://claude.ai/artifact/Qrx8S8tjzd8QUxEnw3u7wa

## Files

| File | What it is |
|---|---|
| `pathways/cough_fast_breathing/v1.json` | The logic model. Hand-written reference draft. |
| `schema/logic-model.schema.json` | The schema: the empty template and the rules for each box. |
| `checks/check.mjs` | Runs every check on a version. |
| `checks/selftest.mjs` | Plants each mistake the checks claim to catch and asserts the matching flag appears. |
| `scripts/extract-pages.mjs` | Regenerates `guideline_text/` from `../Backend/extraction/input_blocks.json`. |
| `guideline_text/p1.txt` to `p12.txt` | Text of each page of the 12-page guideline extraction, used to verify quotes. |
| `docs/BRD.md` | Business requirements (AR, RR, GR rule IDs cited in the spec). |
| `package.json` | Dependencies for the checker (Ajv). |

## Run the checks

Needs Node.js 20 or later.

```
npm install
npm run check
```

To run the self-test (plants each mistake listed under Checks and asserts it is caught):

```
npm run selftest
```

To check your own logic model:

```
node checks/check.mjs path/to/your-file.json
```

Exit code 0 means no blocking flags. If A1 (schema) fails, your file's shape differs from the spec. Fix that first; nothing else runs until it passes.

## The decision table (first match wins, top to bottom)

| Rule | If | Then | Severity |
|---|---|---|---|
| R1 | outside age range AND danger sign | Refer urgently. No medicine. | 1 |
| R2 | outside age range | Refer to health facility | 2 |
| R3 | danger sign AND (fast breathing OR chest indrawing) | Refer urgently + first antibiotic dose | 1 |
| R4 | danger sign | Refer urgently | 1 |
| R5 | fast breathing | Treat at home, follow up in 3 days | 3 |
| R6 | cough is yes | Cough, no fast breathing | 4 |
| R7 | otherwise | No cough: form doesn't apply | 5 |

Definitions (written once, used by the rules):

- **Outside age range:** age less than 2 months, or 60 months or more (p.3).
- **Fast breathing:** cough is yes AND ((age 2 to 11 months AND 50+ breaths) OR (age 12 to 59 months AND 40+ breaths)) (p.8).
- **Danger sign:** (cough is yes AND cough 14+ days) OR chest indrawing OR convulsions OR not able to drink or feed OR vomits everything OR unusually sleepy (p.6).

Ranges always mean "at least the start, less than the end."

## What's in v1.json

| Section | Holds |
|---|---|
| `meta` | version, parent version, author role, change note, guideline fingerprint |
| `scope` | the age range covered, and what this pathway leaves out |
| `questions` | 9 inputs: type, unit, entry limits, when shown, source |
| `derived` | the 3 definitions above |
| `outcomes` | 7 outcomes: severity, actions, doses by age, follow-up |
| `rules` | the 7 rules above; each points to an outcome by name |
| `open_questions` | 6 questions the guideline doesn't answer |

Every row has an `origin`: `guideline` (needs a page and exact quote), `team` (our choice, not in the guideline) or `clinician` (decided by the clinician). When an open question is answered, the rows it affects change origin to `clinician`. Only `guideline` rows need a source; `team` and `clinician` rows may omit it, and check B2 skips them. This matches the Backend schema, which allows the same three origins. Changing a row's origin changes the model content, so the model fingerprint changes and the version needs new signatures.

## Checks

| Code | Checks | Catches |
|---|---|---|
| A1 | schema | malformed drafts. If it fails, nothing else runs. |
| A2, D1 | references and question order | a rule pointing to something that doesn't exist |
| B1 | quote is on the cited page | invented sources |
| B2 | condition numbers match the quote, by unit | wrong thresholds, such as 60 instead of 50 |
| C2 | who reaches the catch-all | a missing rule |
| C6 | every rule wins at least once | rules in the wrong order |
| C5 | no child gets a less severe outcome than a fitting rule offers | a downgraded referral |
| D2 | no condition reads an unasked question | blanks behaving differently on the phone |
| E1 | every child reaching a dose finds one | gaps in dose bands |
| Q | open questions | signing stays blocked until none are open |

`npm run selftest` plants these mistakes in a copy of the final model: a wrong threshold (B2), an invented quote (B1), rules in the wrong order (C6), a missing dose band (E1), a rule pointing at a missing outcome (A2), a removed R6 so cough = yes children reach the catch-all (C2), a downgraded referral (C5), a question read before it is asked (D1), a condition reading an unasked question (D2), and invalid shapes (A1). It also checks that a missing unit raises a B2 flag and that a quote on a page with no text file raises a B1 flag. It passes only if every one is caught and the clean model has no flags.

## Guideline text and fingerprint

`guideline_text/pN.txt` is generated, not hand-written. `npm run extract-pages` reads `../Backend/extraction/input_blocks.json` and writes one file per `pdf_page`: the block texts joined by a newline. Run it again if the extraction changes. Page numbers in quotes are `pdf_page` numbers of that extraction (p1 to p12). If a quote cites a page with no text file, check B1 raises a flag (it does not crash).

Open decision for the team: the model's `meta.guideline.file_sha256` (`a48907d6...`) is the fingerprint of the 16-page booklet, but the 12-page file used for extraction (`Cough_Guideline.pdf`) has sha256 `0d74150d...`. They are different files. The model file was not changed. The team needs to decide which document is the source of record and then make the fingerprint and the page numbers agree with it.

## How this relates to the Backend

The Backend (`Backend/`, TypeScript, zod schema in `Backend/src/logic/schema.ts`) is the system of record. This folder is the reference, standalone checker: it can validate a model file without running the Backend. Its schema accepts what the Backend can produce (`created_by` of `ai_draft`, `ai`, `program_officer` or `clinician`; `source` as one object or an array; empty `affects`; integer questions without `unit` or `constraint`; severity 1 to 9; ids up to 64 characters; quotes up to 2000 characters; `hit_policy` required). It does not repeat every Backend rule. The Backend is stricter on: blank strings, list length caps, condition nesting depth, reserved ids, constraint min <= max, constraint only on integer questions, unique ascending question order, unique rule priorities, and exactly one `otherwise` rule on the highest priority. This schema is stricter than the Backend on `pathway_id` (this pathway only), the minimum quote length (3) and the unit names used by B2 (months, days, breaths_per_minute). A guideline condition on a question with a missing or unknown unit raises a B2 flag, because its number cannot be matched to the quote.

Known gap: the Backend accepts any text for `meta.created_by` (a saved version can carry a demo author name), while this schema accepts only the four values above. Such a file fails A1 here until the team decides whether to loosen this.

## Open questions (signing is blocked until all are resolved)

| # | Question | Who |
|---|---|---|
| Q1 | Is a 12-month-old in the 40-breaths group? | Clinician |
| Q2 | Out-of-range children: urgent referral if a danger sign, routine otherwise, no medicine. Right? | Clinician |
| Q3 | What happens for cough without fast breathing? | Clinician |
| Q4 | Is a cough-only form safe without the diarrhoea, fever and nutrition danger signs? | Clinician |
| Q5 | How many days should a follow-up task stay open? | Program officer |
| Q6 | Are our entry limits sensible? | Clinician |

## Storage

- Each version is one JSON file in S3, never overwritten. Any edit makes a new version.
- Signatures live separately in DynamoDB. Each points at a version and its fingerprint.
- The review screen reads the JSON and draws the tables. People never edit JSON by hand.

## Not in the logic model (on purpose)

- **Signatures.** Kept outside, so signing never changes the signed file.
- **CHT plumbing** (form id, which contact it attaches to, `properties.json`). Goes in a separate compiler config. It isn't clinical.

## Next steps

1. Day 1: compile a tiny slice (one question, one definition, one rule, one outcome) end to end through cht-conf.
2. Check the input format of Medic's `generate-xlsform.py` before deciding whether our compiler writes XLSForm directly.
3. Write the ~12 golden cases from the booklet before looking at any AI draft.
4. Take Q1 to Q6 to Medic at the design review.
