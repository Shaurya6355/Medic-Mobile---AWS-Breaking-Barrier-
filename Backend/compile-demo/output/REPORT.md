# Compile demo report

Model: `cough_fast_breathing` v1 (fixture `Backend/tests/fixtures/logic/v1.json`)  
modelSha: `3dcbacce7f6065dd4394c6cea1b1e4b268c607e8fc487d40ad4a67d804b22955`  
Build: **preview**, form version `preview-3dcbacce`: preview build, not approved, not deployable.  
cht-conf: 6.6.1 (npm, compile-demo/tools). Python for xls2xform-medic: `/opt/homebrew/bin/python3.13`.  
Overall: **PASS**

Synthetic data only. The settings used (`compile-demo/settings.demo.json`) are demo placeholders.

## 0. Question flow

flowMode: **minimal** (flow derivation version `flow-2-is_no`). Average questions asked over the 6400-combination grid: **3.19** (all questions: 8.92).
Flow tree: 105 nodes, 54 leaves. Always asked: age_months. Sometimes skipped: cough, cough_days, convulsions, not_able_to_drink_or_feed, vomits_everything, chest_indrawing, breaths_per_minute, unusually_sleepy. Never asked: none. verifyFlow before emitting: 0 tree / 0 compiled mismatches, 0 sequence differences (the compile refuses on any mismatch).
Diagram and plain sentences for minimal and danger_signs_always: [flow.md](flow.md), [flow.html](flow.html) (offline).
The minimal flow never asks danger-sign questions of a child outside the age range (the outcome is already decided); `--flow=danger_signs_always` asks them always. The clinician chooses.

## 1. What was compiled (compileSnapshot manifest)

| file | bytes | sha256 |
| --- | --- | --- |
| project/.eslintrc | 106 | `69900468e911f75d4c15ff56b504da43d2d76a7489847e076c6d5cd1868354e7` |
| project/README.md | 2462 | `9b1e88cf28f62727118f95d3e1bb6202ef884b1170b3735d590527bd9467cb9c` |
| project/app_settings/base_settings.json | 48 | `e2d2dbd149367821f4c64ad15a1ee28ffc8a29b60651208781b4b3aba33b57e5` |
| project/contact-summary.templated.js | 63 | `22b31b3000a60f1f5dda4d0cc8d885fdb081870d3908247ff7e353414a262e6e` |
| project/forms/app/cough_fast_breathing.properties.json | 202 | `341d653852d2d29324f5d8e5f04b658136dd254df33846c4b094aef9579664ea` |
| project/forms/app/cough_fast_breathing.xlsx | 10472 | `9915aa917725f813ab42e55cd8c87efd79ad85778ff9cc999213791473a252ac` |
| project/package.json | 245 | `7da897f481c6ca033b1ac7ba5e5377955688d0f2909d55637318063116c7441c` |
| project/sourcemap.json | 10779 | `c740e8b6d24fa927f65f02272a21eff4ba937247590c5af22eda0e1b5cdf47e3` |
| project/targets.js | 21 | `4707cce5979ba8f9408b54b0f076b033f630f1d29476e110730be212556a9cae` |
| project/tasks.js | 1752 | `f66ce75e638dea7a04d5f0970c6f17cd126b1a3425f0c5fad7a422769f373f75` |
| project/translations/messages-en.properties | 140 | `869524bf9ac92e18c20cddbf882c1837d003e6b0ef20249ccbc55e3d7d9be61c` |

Files added by cht-conf:

| file | bytes | sha256 |
| --- | --- | --- |
| project/forms/app/cough_fast_breathing.xml | 25264 | `c6d6c7fb5cc40af65bb667f243d2682fd4b34f657406be33295d3f4b9ace0d37` |
| project/app_settings.json | 7976 | `d82d349c37ebc74b57f1282aa6ffcb6c9b8d3643fdce6daca653b445e8865ad7` |

- Generated XForm: `compile-demo/output/project/forms/app/cough_fast_breathing.xml` (instanceID present: true, outcome bind present: true)
- Compiled app settings: `compile-demo/output/project/app_settings.json` (tasks.isDeclarative: true, compiled task rules 5587 chars, targets {"enabled":true,"items":[]})
- Source XLSForm: `compile-demo/output/project/forms/app/cough_fast_breathing.xlsx`
- Sourcemap (row/task -> model item and {page, quote}): `compile-demo/output/project/sourcemap.json`
- Browser view of the survey: `compile-demo/output/survey.html`

## 2. cht-conf steps

Run in this order: convert-app-forms (xlsx -> XForm via xls2xform-medic), validate-app-forms (reads the XForm, so it
must follow convert, as in cht-conf's own default action order), compile-app-settings (tasks.js, targets.js,
contact summary, base settings -> app_settings.json). Flags: `--source=<project> --skip-dependency-check
--skip-version-check --skip-git-check <action>`; no `--local`/`--url`, so no CouchDB is needed.

| step | result | exit | errors | warnings | log |
| --- | --- | --- | --- | --- | --- |
| convert-app-forms | PASS | 0 | 0 | 0 | `compile-demo/output/logs/1-convert-app-forms.log` |
| validate-app-forms | PASS | 0 | 0 | 1 | `compile-demo/output/logs/2-validate-app-forms.log` |
| compile-app-settings | PASS | 0 | 0 | 1 | `compile-demo/output/logs/3-compile-app-settings.log` |

### convert-app-forms: PASS

```text
$ cht '--source=<repo>/Backend/compile-demo/output/project' --skip-dependency-check --skip-version-check --skip-git-check convert-app-forms
# exit 0 in 719 ms
# ---- stdout
INFO Processing config in project. 
INFO Actions:
     - convert-app-forms 
INFO Starting action: convert-app-forms… 
INFO Converting form <repo>/Backend/compile-demo/output/project/forms/app/cough_fast_breathing.xlsx … 
INFO convert-app-forms complete. 

# ---- stderr
```

### validate-app-forms: PASS

```text
$ cht '--source=<repo>/Backend/compile-demo/output/project' --skip-dependency-check --skip-version-check --skip-git-check validate-app-forms
# exit 0 in 270 ms
# ---- stdout
INFO Processing config in project. 
INFO Actions:
     - validate-app-forms 
INFO Starting action: validate-app-forms… 
INFO Validating form: cough_fast_breathing.xml… 
WARN Some validations have been skipped because they require a CHT instance. 
INFO validate-app-forms complete. 

# ---- stderr
```

### compile-app-settings: PASS

```text
INFO Actions:
     - compile-app-settings 
INFO Starting action: compile-app-settings… 
INFO Packaging contact-summary 
INFO asset ./contact-summary.js 2.08 KiB [compared for emit] [minimized] (name: main)
../../tools/node_modules/cht-conf/src/contact-summary/lib.js 203 bytes [built] [code generated]
./contact-summary.templated.js 63 bytes [built] [code generated]
../../tools/node_modules/cht-conf/src/contact-summary/contact-summary-emitter.js 3.51 KiB [built] [code generated]
webpack 5.112.2 compiled successfully in 348 ms 
INFO Packaging nools 
INFO asset ./nools.js 5.46 KiB [compared for emit] [minimized] (name: main)
modules by path ../../tools/node_modules/cht-conf/src/nools/*.js 11.1 KiB
  ../../tools/node_modules/cht-conf/src/nools/lib.js 328 bytes [built] [code generated]
  ../../tools/node_modules/cht-conf/src/nools/task-emitter.js 5.27 KiB [built] [code generated]
  ../../tools/node_modules/cht-conf/src/nools/target-emitter.js 2.83 KiB [built] [code generated]
  ../../tools/node_modules/cht-conf/src/nools/definition-preparation.js 1.36 KiB [built] [code generated]
  ../../tools/node_modules/cht-conf/src/nools/task-defaults.js 1.32 KiB [built] [code generated]
modules by path ./*.js 1.73 KiB
  ./tasks.js 1.71 KiB [built] [code generated]
  ./targets.js 21 bytes [built] [code generated]
webpack 5.112.2 compiled successfully in 93 ms 
WARN Setting purge configuration to empty object as purge.js and purging.js files were not found. 
INFO compile-app-settings complete. 

# ---- stderr
```

### Validations cht-conf skips without a CHT instance

validate-app-forms ran has-instance-id, no-required-notes, check-xpaths-exist, db-doc-is-valid, db-doc-ref-is-valid and
validate-field-paths. It skipped deprecated-appearance, deprecated-tel-type and can-generate-xform because they need an instance.
The first two only need a version number, so this run also executed them directly with apiVersion 5.3.0
(assumed: the local cht-core checkout version). can-generate-xform posts the form to the CHT API and was NOT run.

| validation | errors | warnings |
| --- | --- | --- |
| deprecated-appearance | 0 | 0 |
| deprecated-tel-type | 0 | 0 |

## 3. Survey sheet

| type | name | label::en | required | relevant | appearance | constraint | constraint_message::en | calculation | default |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| begin group | inputs |  |  | ./source = 'user' | field-list |  |  |  |  |
| hidden | source | Source |  |  |  |  |  |  | user |
| hidden | source_id | Source ID |  |  |  |  |  |  |  |
| begin group | contact | Contact |  |  |  |  |  |  |  |
| string | _id | Who is this assessment for? |  |  | select-contact type-person |  |  |  |  |
| hidden | name | Name |  |  |  |  |  |  |  |
| hidden | patient_id | Patient ID |  |  |  |  |  |  |  |
| end group | contact |  |  |  |  |  |  |  |  |
| end group | inputs |  |  |  |  |  |  |  |  |
| calculate | patient_uuid |  |  |  |  |  |  | ../inputs/contact/_id |  |
| calculate | patient_id |  |  |  |  |  |  | ../inputs/contact/patient_id |  |
| calculate | patient_name |  |  |  |  |  |  | ../inputs/contact/name |  |
| begin group | q_age_months |  |  |  | field-list |  |  |  |  |
| integer | age_months | Child's age in months | yes |  |  | . >= 0 and . <= 120 | Enter age in whole months. |  |  |
| end group | q_age_months |  |  |  |  |  |  |  |  |
| begin group | q_cough |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60)) | field-list |  |  |  |  |
| select_one yes_no | cough | Does the child have a cough? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60)) |  |  |  |  |  |
| end group | q_cough |  |  |  |  |  |  |  |  |
| begin group | q_cough_days |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes') | field-list |  |  |  |  |
| integer | cough_days | For how many days has the child had the cough? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes') |  | . >= 0 and . <= 365 | Enter a number of days. |  |  |
| end group | q_cough_days |  |  |  |  |  |  |  |  |
| begin group | q_convulsions |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) | field-list |  |  |  |  |
| select_one yes_no | convulsions | Has the child had convulsions? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) |  |  |  |  |  |
| end group | q_convulsions |  |  |  |  |  |  |  |  |
| begin group | q_not_able_to_drink_or_feed |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) | field-list |  |  |  |  |
| select_one yes_no | not_able_to_drink_or_feed | Is the child not able to drink or feed anything? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) |  |  |  |  |  |
| end group | q_not_able_to_drink_or_feed |  |  |  |  |  |  |  |  |
| begin group | q_vomits_everything |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and ${not_able_to_drink_or_feed} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) | field-list |  |  |  |  |
| select_one yes_no | vomits_everything | Does the child vomit everything? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and ${not_able_to_drink_or_feed} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) |  |  |  |  |  |
| end group | q_vomits_everything |  |  |  |  |  |  |  |  |
| begin group | q_chest_indrawing |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60)) | field-list |  |  |  |  |
| select_one yes_no | chest_indrawing | Look: does the child have chest indrawing? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60)) |  |  |  |  |  |
| end group | q_chest_indrawing |  |  |  |  |  |  |  |  |
| begin group | q_breaths_per_minute |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes' and ${chest_indrawing} = 'no') | field-list |  |  |  |  |
| integer | breaths_per_minute | Count the child's breaths in 1 minute | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes' and ${chest_indrawing} = 'no') |  | . >= 10 and . <= 120 | Recount. Enter breaths in one full minute. |  |  |
| end group | q_breaths_per_minute |  |  |  |  |  |  |  |  |
| begin group | q_unusually_sleepy |  |  | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and ${not_able_to_drink_or_feed} = 'no' and ${vomits_everything} = 'no' and ${chest_indrawing} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) | field-list |  |  |  |  |
| select_one yes_no | unusually_sleepy | Look: is the child unusually sleepy or unconscious? | yes | ((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and ${not_able_to_drink_or_feed} = 'no' and ${vomits_everything} = 'no' and ${chest_indrawing} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14)))) |  |  |  |  |  |
| end group | q_unusually_sleepy |  |  |  |  |  |  |  |  |
| calculate | fast_breathing |  |  |  |  |  |  | if((${cough} = 'yes' and (((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 12) and (${breaths_per_minute} != '' and ${breaths_per_minute} >= 50)) or ((${age_months} != '' and ${age_months} >= 12) and (${age_months} != '' and ${age_months} < 60) and (${breaths_per_minute} != '' and ${breaths_per_minute} >= 40)))), 'yes', 'no') |  |
| calculate | danger_sign |  |  |  |  |  |  | if(((${cough} = 'yes' and (${cough_days} != '' and ${cough_days} >= 14)) or ${convulsions} = 'yes' or ${not_able_to_drink_or_feed} = 'yes' or ${vomits_everything} = 'yes' or ${chest_indrawing} = 'yes' or ${unusually_sleepy} = 'yes'), 'yes', 'no') |  |
| calculate | outcome |  |  |  |  |  |  | if(((${age_months} != '' and ${age_months} < 2) or (${age_months} != '' and ${age_months} >= 60)), 'refer_outside_age_range', if((${danger_sign} = 'yes' and (${fast_breathing} = 'yes' or ${chest_indrawing} = 'yes')), 'refer_urgent_with_antibiotic', if(${danger_sign} = 'yes', 'refer_urgent', if(${fast_breathing} = 'yes', 'treat_fast_breathing_at_home', if(${cough} = 'yes', 'cough_no_fast_breathing', 'no_cough'))))) |  |
| begin group | results | Result |  |  | field-list |  |  |  |  |
| note | outcome_refer_outside_age_range | Refer to health facility: child is outside the age range this form covers<br>Refer child to health facility, write a referral note, and follow up child on return. |  | ${outcome} = 'refer_outside_age_range' |  |  |  |  |  |
| note | outcome_refer_urgent_with_antibiotic | Danger sign: refer urgently and give first dose of antibiotic<br>Give first dose of oral antibiotic (amoxicillin tablet, 250 mg).<br>Explain why the child needs to go to the health facility. Write a referral note and help arrange transport. |  | ${outcome} = 'refer_urgent_with_antibiotic' |  |  |  |  |  |
| note | outcome_refer_urgent_with_antibiotic_dose_1_1 | Age 2 to under 12 months: 1 tablet |  | ${outcome} = 'refer_urgent_with_antibiotic' and (${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 12) |  |  |  |  |  |
| note | outcome_refer_urgent_with_antibiotic_dose_1_2 | Age 12 to under 60 months: 2 tablets |  | ${outcome} = 'refer_urgent_with_antibiotic' and (${age_months} != '' and ${age_months} >= 12) and (${age_months} != '' and ${age_months} < 60) |  |  |  |  |  |
| note | outcome_refer_urgent | Danger sign: refer urgently<br>Explain why the child needs to go to the health facility. Write a referral note and help arrange transport. |  | ${outcome} = 'refer_urgent' |  |  |  |  |  |
| note | outcome_treat_fast_breathing_at_home | Fast breathing (pneumonia): treat at home and follow up in 3 days<br>Give oral antibiotic (amoxicillin tablet, 250 mg) twice daily for 5 days. Help the caregiver give the first dose now.<br>Advise to return immediately if the child cannot drink or feed, becomes sicker, or has blood in stool. |  | ${outcome} = 'treat_fast_breathing_at_home' |  |  |  |  |  |
| note | outcome_treat_fast_breathing_at_home_dose_1_1 | Age 2 to under 12 months: 1 tablet (total 10 tablets) |  | ${outcome} = 'treat_fast_breathing_at_home' and (${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 12) |  |  |  |  |  |
| note | outcome_treat_fast_breathing_at_home_dose_1_2 | Age 12 to under 60 months: 2 tablets (total 20 tablets) |  | ${outcome} = 'treat_fast_breathing_at_home' and (${age_months} != '' and ${age_months} >= 12) and (${age_months} != '' and ${age_months} < 60) |  |  |  |  |  |
| note | outcome_cough_no_fast_breathing | Cough without fast breathing or danger signs<br>Advise the caregiver to give more fluids and continue feeding. Advise when to return. |  | ${outcome} = 'cough_no_fast_breathing' |  |  |  |  |  |
| note | outcome_no_cough | No cough: this form does not apply. Assess other problems.<br>Continue with the other parts of the sick child assessment. |  | ${outcome} = 'no_cough' |  |  |  |  |  |
| end group | results |  |  |  |  |  |  |  |  |

## 4. Choices sheet

| list_name | name | label::en |
| --- | --- | --- |
| yes_no | yes | Yes |
| yes_no | no | No |

Settings sheet: 

| form_title | form_id | version | default_language | style |
| --- | --- | --- | --- | --- |
| Cough and fast breathing (demo preview) | cough_fast_breathing | preview-3dcbacce | en | pages |

## 5. Generated tasks.js

```js
// Generated by the logic-model compiler from cough_fast_breathing (modelSha 3dcbacce). Do not edit by hand.
const FORM_ID = 'cough_fast_breathing';

function getField(report, path) {
  return ['fields'].concat((path || '').split('.')).reduce(function (prev, key) {
    return prev === undefined || prev === null ? undefined : prev[key];
  }, report);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() + days);
  return result;
}

function isFormSubmittedInWindow(reports, form, start, end) {
  return (reports || []).some(function (r) {
    return r.form === form && r.reported_date >= start && r.reported_date <= end;
  });
}

// Resolved when a later report of the same form for the same patient arrives inside the
// event window (same pattern as the cht-core default config tasks.js).
function resolvedByLaterReport(contact, report, event, dueDate) {
  const startTime = Math.max(addDays(dueDate, -event.start).getTime(), report.reported_date + 1);
  const endTime = addDays(dueDate, event.end + 1).getTime();
  return isFormSubmittedInWindow(contact.reports, FORM_ID, startTime, endTime);
}

module.exports = [
  {
    name: 'cough_fast_breathing.treat_fast_breathing_at_home.follow_up',
    icon: 'icon-healthcare',
    title: 'task.cough_fast_breathing.treat_fast_breathing_at_home.title',
    appliesTo: 'reports',
    appliesToType: [FORM_ID],
    appliesIf: function (contact, report) {
      return getField(report, 'outcome') === 'treat_fast_breathing_at_home';
    },
    resolvedIf: resolvedByLaterReport,
    actions: [{ type: 'report', form: FORM_ID }],
    events: [{ id: 'treat_fast_breathing_at_home-follow-up', days: 3, start: 0, end: 7 }],
  },
];
```

## 6. Generated properties.json

```json
{
  "title": [
    {
      "locale": "en",
      "content": "Cough and fast breathing (demo preview)"
    }
  ],
  "icon": "icon-healthcare",
  "context": {
    "person": true,
    "place": false
  }
}
```

## 7. Not compiled and warnings

| item | reason |
| --- | --- |
| outcomes.refer_outside_age_range.follow_up | needs a return date (no trigger defined) |
| outcomes.refer_urgent_with_antibiotic.follow_up | needs a return date (no trigger defined) |
| outcomes.refer_urgent.follow_up | needs a return date (no trigger defined) |

- TEAM_DEFAULT_USED: outcomes.treat_fast_breathing_at_home.follow_up.task_window_days_after_due is null; used settings.taskWindowDays = 7 (open question Q5)
- NOT_COMPILED: outcomes.refer_outside_age_range.follow_up: needs a return date (no trigger defined)
- NOT_COMPILED: outcomes.refer_urgent_with_antibiotic.follow_up: needs a return date (no trigger defined)
- NOT_COMPILED: outcomes.refer_urgent.follow_up: needs a return date (no trigger defined)

Note: `refer_urgent_with_antibiotic` and `refer_urgent` carry due_in_days 7 but kind `on_return`; per the compiler rules
on_return follow-ups are not turned into tasks until a return trigger is defined.

## 8. Determinism

Compiled twice (second run in a temp directory): all 11 generated files have identical sha256, including the .xlsx.
Sheet contents read back from both .xlsx files: identical.
How: exceljs stamps zip entries with the current time, so the compiler fixes workbook creator/created/modified and
re-packs the zip with JSZip giving every entry the same fixed date (byte-level determinism, not just sheet equality).
The cht-conf outputs (XForm, app_settings.json) are not part of this comparison.

## 9. Not yet verified

- compile:demo alone does not fill the form: `npm run compile:verify` does (golden cases in the UI, edit scenarios, the
  differential grid against the interpreter in the CHT enketo engine); its result is linked below once it has run.
- tasks.js and targets behaviour are not exercised (needs cht-conf-test-harness).
- No round-trip parse-back (XForm or xlsx -> logic model) has been done.
- Not approved, not signed: this is a preview build and must not be deployed.
- can-generate-xform (CHT API form validation) was not run: there is no CHT instance.
- Demo settings (form title, icon, 7-day task window for Q5, contact types) are placeholders, not decisions.
- Open questions Q1 to Q6 in the model are still open; the compiled logic reflects the current draft answers.

<!-- verify:start -->
## Form preview and verification (compile:preview, compile:verify)

Overall: **PASS**. Details: [VERIFY.md](VERIFY.md). Form preview: `preview/index.html` (or `npm run compile:preview`). Screenshots: `screenshots/`.

- flowMode minimal: average questions asked 3.19 per grid point (all questions 8.92).
- Golden cases typed into the real form (enketo-core 7.2.5, CHT config), only the screens that appear: 15/15 pass.
- Edit scenarios with stale hidden values: 4/4 pass.
- Differential grid vs interpreter: 6400 points, 0 mismatches.
- Partial answers (informational): 6400 points, 0 mismatches.
- Mutation self-check (flowMode minimal): 4/4 planted bugs caught (plus 3 equivalent mutants correctly not flagged).

<!-- verify:end -->
