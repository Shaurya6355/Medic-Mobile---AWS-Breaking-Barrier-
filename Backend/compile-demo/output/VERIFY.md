# VERIFY: compiled CHT form vs golden cases and the logic interpreter

PREVIEW BUILD, not approved, demo settings. Synthetic data only. The golden outcomes are proposed from v1.json and the booklet, not clinically confirmed (awaiting Medic).

Overall: **PASS**  
Form under test: `compile-demo/output/project/forms/app/cough_fast_breathing.xml` (cht-conf 6.6.1 output), sha256 `3f6d958695ee4eb4937492086bcf77b7b33bee82de31ef6fcf7ca9e4b926cd71`  
Model: `tests/fixtures/logic/v1.json` (cough_fast_breathing v1); interpreter: `src/logic` evaluate()  
Engine: enketo-core 7.2.5 + openrosa-xpath-evaluator 2.0.13 in headless Google Chrome, CHT webapp enketo config (excludeNonRelevant: true, validatePage: true), CHT's enketo-core patch (/inputs always relevant), HTML and model made with cht-core's XSL (as cht-core api does). Opened as from a contact profile with a synthetic contact.  
Flow: **flowMode minimal** (from `output/manifest.json`; flow derivation `flow-2-is_no`)  
**Average questions asked: 4.67 per grid point in the CHT engine** (flow prediction 4.67, all questions 8.92); 6.75 screens per golden case typed in the UI.  
Run time: 745.3 s. Re-run: `cd Backend && npm run compile:verify` (after `npm run compile:demo -- --flow=<mode>` for another mode).

## 1. Golden cases (UI level)

Each case was typed into the real form inputs (radio clicks, number fields), the real Next button was pressed (enketo page validation), the result page was read, and the form was submitted (enketo validate()). Pass = form outcome, interpreter outcome and expected outcome agree, fast_breathing and danger_sign agree with the interpreter, the visible result notes equal the model's notes for that outcome (outcome note plus the dose note for the child's age band), the screens that appeared were exactly the questions the flow asks for that case, in order (the case's answers to skipped questions were not typed), and validation passed. fast_breathing and danger_sign are compared with the interpreter on the answers actually shown (a skipped question is blank in CHT).

| case | description | expected | interpreter | compiled form | screens (shown / expected) | fast_breathing (form/interp) | danger_sign (form/interp) | visible result notes | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| g01 | 6 months, 52 breaths | treat_fast_breathing_at_home | treat_fast_breathing_at_home | treat_fast_breathing_at_home | 9 / 9 | yes/yes | no/no | outcome_treat_fast_breathing_at_home, outcome_treat_fast_breathing_at_home_dose_1_1 | PASS |
| g02 | 6 months, exactly 50 breaths | treat_fast_breathing_at_home | treat_fast_breathing_at_home | treat_fast_breathing_at_home | 9 / 9 | yes/yes | no/no | outcome_treat_fast_breathing_at_home, outcome_treat_fast_breathing_at_home_dose_1_1 | PASS |
| g03 | 6 months, 49 breaths | cough_no_fast_breathing | cough_no_fast_breathing | cough_no_fast_breathing | 9 / 9 | no/no | no/no | outcome_cough_no_fast_breathing | PASS |
| g04 | 11 months, 45 breaths | cough_no_fast_breathing | cough_no_fast_breathing | cough_no_fast_breathing | 9 / 9 | no/no | no/no | outcome_cough_no_fast_breathing | PASS |
| g05 | Exactly 12 months, 40 breaths | treat_fast_breathing_at_home | treat_fast_breathing_at_home | treat_fast_breathing_at_home | 9 / 9 | yes/yes | no/no | outcome_treat_fast_breathing_at_home, outcome_treat_fast_breathing_at_home_dose_1_2 | PASS |
| g06 | 12 months, 39 breaths | cough_no_fast_breathing | cough_no_fast_breathing | cough_no_fast_breathing | 9 / 9 | no/no | no/no | outcome_cough_no_fast_breathing | PASS |
| g07 | 59 months, 40 breaths | treat_fast_breathing_at_home | treat_fast_breathing_at_home | treat_fast_breathing_at_home | 9 / 9 | yes/yes | no/no | outcome_treat_fast_breathing_at_home, outcome_treat_fast_breathing_at_home_dose_1_2 | PASS |
| g08 | 60 months, no cough | refer_outside_age_range | refer_outside_age_range | refer_outside_age_range | 7 / 7 | no/no | no/no | outcome_refer_outside_age_range | PASS |
| g09 | 1 month, no cough | refer_outside_age_range | refer_outside_age_range | refer_outside_age_range | 7 / 7 | no/no | no/no | outcome_refer_outside_age_range | PASS |
| g10 | Cough 14 days, no fast breathing | refer_urgent | refer_urgent | refer_urgent | 5 / 5 | no/no | yes/yes | outcome_refer_urgent | PASS |
| g11 | Cough 14 days with fast breathing | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | 5 / 5 | yes/yes | yes/yes | outcome_refer_urgent_with_antibiotic, outcome_refer_urgent_with_antibiotic_dose_1_2 | PASS |
| g12 | Chest indrawing alone | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | 6 / 6 | no/no | yes/yes | outcome_refer_urgent_with_antibiotic, outcome_refer_urgent_with_antibiotic_dose_1_2 | PASS |
| g13 | No cough, convulsions | refer_urgent | refer_urgent | refer_urgent | 4 / 4 | no/no | yes/yes | outcome_refer_urgent | PASS |
| g14 | No cough, no signs | no_cough | no_cough | no_cough | 7 / 7 | no/no | no/no | outcome_no_cough | PASS |
| g15 | Outside the age range with a danger sign: 1 month old with convulsions | refer_urgent_outside_age_range | refer_urgent_outside_age_range | refer_urgent_outside_age_range | 3 / 3 | no/no | yes/yes | outcome_refer_urgent_outside_age_range | PASS |
| g16 | 6 months, convulsions and 55 breaths (danger sign with fast breathing in an infant) | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | refer_urgent_with_antibiotic | 6 / 6 | yes/yes | yes/yes | outcome_refer_urgent_with_antibiotic, outcome_refer_urgent_with_antibiotic_dose_1_1 | PASS |
| g17 | Outside the age range with a danger sign: 1 month old with chest indrawing | refer_urgent_outside_age_range | refer_urgent_outside_age_range | refer_urgent_outside_age_range | 6 / 6 | no/no | yes/yes | outcome_refer_urgent_outside_age_range | PASS |
| g18 | 60 months with convulsions (outside the age range, danger sign) | refer_urgent_outside_age_range | refer_urgent_outside_age_range | refer_urgent_outside_age_range | 4 / 4 | no/no | yes/yes | outcome_refer_urgent_outside_age_range | PASS |
| g19 | 1 month, cough 14 days (outside the age range, danger sign from long cough) | refer_urgent_outside_age_range | refer_urgent_outside_age_range | refer_urgent_outside_age_range | 3 / 3 | no/no | yes/yes | outcome_refer_urgent_outside_age_range | PASS |
| g20 | 2 months, 49 breaths, no signs (youngest covered age) | cough_no_fast_breathing | cough_no_fast_breathing | cough_no_fast_breathing | 9 / 9 | no/no | no/no | outcome_cough_no_fast_breathing | PASS |

Golden: 20/20 pass (interpreter equals expected in 20/20).

Note text shown for g01 (exactly as on screen):

```
Fast breathing (pneumonia): treat at home and follow up in 3 days
Give oral antibiotic (amoxicillin tablet, 250 mg) twice daily for 5 days. Help the caregiver give the first dose now.
Advise to return immediately if the child cannot drink or feed, becomes sicker, or has blood in stool.

Age 2 to under 12 months: 1 tablet (total 10 tablets)

```

## 2. Edit scenarios (UI level, stale hidden values)

Answers were changed after first entry, so a now-hidden question still holds its old value in the model. CHT's config (excludeNonRelevant) treats hidden values as blank in calculations and drops them on save; the interpreter drops answers to hidden questions. After the edit the form is walked again from the first screen (an edit can bring back screens the flow had skipped), answering only the screens that appear. Outcome and notes must equal the interpreter on the full final answers; the screens must equal the flow's sequence.

| case | scenario | interpreter | compiled form | fast_breathing (form/interp) | danger_sign (form/interp) | notes | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e1 | Cough 20 days (danger sign) entered, then cough changed to no: hidden cough_days keeps 20 | no_cough | no_cough | no/no | no/no | outcome_no_cough | PASS |
| e2 | 52 breaths at 6 months (fast) entered, then cough changed to no: hidden breaths keep 52 | no_cough | no_cough | no/no | no/no | outcome_no_cough | PASS |
| e3 | Cough no first, then cough yes with 3 days and 45 breaths at 24 months | treat_fast_breathing_at_home | treat_fast_breathing_at_home | yes/yes | no/no | outcome_treat_fast_breathing_at_home, outcome_treat_fast_breathing_at_home_dose_1_2 | PASS |
| e4 | Fast breathing at 6 months, then age corrected to 70 months | refer_outside_age_range | refer_outside_age_range | no/no | no/no | outcome_refer_outside_age_range | PASS |

Edit scenarios: 4/4 pass.

## 3. Differential grid (model level)

Points: 6400 from enumerateAnswers(model) (exact: true; every integer cut point of every threshold and constraint bound, every yes/no combination, hidden questions omitted). Each point: a fresh enketo form, values set on the model nodes, enketo's evaluation cascade run, calculate nodes and relevant result notes read. Every answer of the point is set, including questions the flow hides: enketo (excludeNonRelevant, as in CHT) treats hidden questions as blank. Outcome and notes are compared with evaluate() on the FULL answers (so the short form must give the outcome of answering everything); fast_breathing and danger_sign with evaluate() on the shown answers; the questions enketo shows with the flow's sequence.

Compared: 6400. **Mismatches: 0** (of which shown-question differences: 0). Average questions shown: 4.67.

| outcome (interpreter) | points |
| --- | --- |
| refer_urgent_outside_age_range | 3148 |
| refer_outside_age_range | 52 |
| refer_urgent_with_antibiotic | 2344 |
| refer_urgent | 804 |
| cough_no_fast_breathing | 24 |
| treat_fast_breathing_at_home | 24 |
| no_cough | 4 |

## 4. Partial answers (informational)

Every grid point again with one shown question left empty (6400 points, the dropped question rotating), compared with evaluate(..., { allowMissing: true }) on outcome, fast_breathing and danger_sign. The real form cannot be submitted like this (all questions are required, enketo blocks Next), so this only checks that empty fields behave the same in both (the compiler guards every comparison with `!= ''`). Mismatches: **0**.

## 5. Mutation self-check (can the grid fail?)

Not run this time (`npm run compile:verify -- --mutation-check` to run it).

## What this proves

- The XPath the compiler emitted, after cht-conf's xlsx-to-XForm conversion, computes the same outcome, fast_breathing and danger_sign as the logic interpreter at every point of the exact answer grid, in the same engine and configuration the CHT webapp uses. This is the check that catches build-stage logic bugs (operator precedence, bracket, threshold and boundary errors).
- The golden cases give their expected outcome when typed into the real form, and the right outcome and dose notes appear.
- Constraints, required fields and relevance work in the form (see the screenshots: `output/screenshots/`).

## What is NOT verified

- CHT-specific widgets: the contact selector (db-object-widget, `select-contact type-person` on inputs/contact/_id) and CHT's other custom widgets are not loaded; the preview opens the form as if launched from a contact profile, so that group is hidden.
- CHT's medic XPath extensions (not used by this form) and CHT's own webapp styles.
- Offline behaviour, PouchDB storage, sync, the saved report document shape in CouchDB (only enketo's record XML is produced), form upload with `cht --local`, and the CHT API's can-generate-xform validation.
- tasks.js behaviour (task appears on the right days, resolves, the 7-day demo window) and targets: nothing here runs the rules engine. cht-conf-test-harness would be needed.
- The contact/patient linkage (patient_uuid etc. are filled from the synthetic contact only) and contact-summary.
- Other languages, real Android devices and CHT app versions other than cht-core 5.3.0's enketo stack.
- Clinical correctness: the golden file and v1.json are proposals awaiting Medic, and the interpreter is itself the reference here (a shared misreading of the guideline would not be caught).

## Per flow mode (latest run of each)

Each row is the latest `compile:verify` for that flow mode (kept in `output/verify-modes/` across recompiles). A row whose modelSha differs from the current model is stale.

| flowMode | overall | avg questions (grid, CHT engine) | screens per golden case | golden | edits | grid mismatches (shown diffs) | partial | mutation check | modelSha |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| danger_signs_always | PASS | 8.20 | 8.20 | 15/15 | 4/4 | 0 (0) | 0 | not run | STALE |
| full | PASS | 8.92 | 8.20 | 15/15 | 4/4 | 0 (0) | 0 | not run | STALE |
| minimal (this run) | PASS | 4.67 | 6.75 | 20/20 | 4/4 | 0 (0) | 0 | not run | current |
