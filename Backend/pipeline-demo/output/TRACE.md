# Pipeline demo trace

Synthetic run on the public WHO/UNICEF cough booklet. FakeModelClient (no Bedrock call). Demo users:
demo-officer-amara (program officer) and demo-clinician-tomas (clinician). Edits by tests/helpers/resolveForDemo.ts (TEST-ONLY;
its answers are placeholders, not clinical decisions). Fixed clock, so this file is the same on every run
except the cht-conf timings in compile/logs.

## 1. Extract output -> fill_logic -> automatic checks (orchestrator)

   step ingest     succeeded tokens in/out 0/0  -> ingest/input_blocks.json
   step extract    succeeded tokens in/out 0/0  -> extract/extraction_output.json
   step fill_logic succeeded tokens in/out 0/0  -> version, draft
   step checks     succeeded tokens in/out 0/0  -> findings, modelSha, version, checksVersion
   run states: (new) -> created | created -> ingesting | ingesting -> extracting | extracting -> filling_logic | filling_logic -> checking | checking -> awaiting_officer
   OK: run is in awaiting_officer (expected awaiting_officer)

## 2. Findings for version 1 (GET findings, per audience)

   modelSha 70a70ce1bdf6...; claim PROVEN; 14 blocking, 6 warning, 29 info
   gates: The program officer cannot sign yet. Still to settle: 5 unanswered open questions. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 9 unanswered open questions. The form cannot be built yet: 14 items still block.
   program_officer: 5 blocking item(s) for them to settle, for example:
     - Open question Q7 has not been answered: How many days should the follow-up task stay open after it is due? The guideline gives the due day only. It concerns tre
     - Open question Q2 has not been answered: The guideline sends the health worker to page 10 to give the first dose of oral medicine, but page 10 is the ORS page an
     - Open question Q14 has not been answered: The guideline publisher and edition were not recorded. Please fill them in. It concerns the draft as a whole. The progr
   clinician: 9 blocking item(s) for them to settle, for example:
     - Open question Q11 has not been answered: The booklet passage for the medicine step act_amox_home ("Give twice daily for 5 days: Age 2 months up to 12 months—1 t
     - Open question Q6 has not been answered: These danger signs from the guideline are not asked in this form: Diarrhoea for 14 days or more; Blood in stool; Fever f
     - Open question Q12 has not been answered: These items rest only on a passage the draft chose to cite, not on a cut-off or a question taken from the guideline, so

## 3. Signing is BLOCKED while blockers exist; compile is REFUSED for an unsigned version

   officer signs v1: HTTP 422 blocked - The program officer cannot sign yet. Still to settle: 5 unanswered open questions. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 9 unanswered open questions. The form cannot be built yet: 14 items still block.
   OK: officer refused with 422 blocked (5 blockers listed)
   clinician signs v1: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   OK: clinician refused with 409: the officer signs first
   [compile] compile refused: release build refused for run pipeline-demo version 1: version 1: is not locked (it needs the program officer's and then the clinician's signature)
   OK: compile of v1 refused (release build refused for run pipeline-demo version 1: version 1: is not locked (it needs the program officer's and then the clinician's signature))

## 4. Second pass: the program officer fixes their items (new version 2)

   OK: POST versions -> 201 (new version 2, author demo-officer-amara)
   v2: status awaiting_officer, run awaiting_officer, modelSha 57aa65f51417...
   gates: The program officer can sign now. The clinician cannot sign yet. Still to settle: 9 unanswered open questions. The form cannot be built yet: 9 items still block.
   OK: officer can sign, clinician still blocked
   officer signs v2: HTTP 201 awaiting_clinician
   OK: officer signature recorded; waiting for the clinician
   clinician signs v2: HTTP 422 blocked - The program officer can sign now. The clinician cannot sign yet. Still to settle: 9 unanswered open questions. The form cannot be built yet: 9 items still block.
   OK: clinician refused with 422: 9 open question(s) routed to the clinician

## 5. The clinician answers their questions (new version 3): signatures start over (AR-04)

   OK: POST versions -> 201 (new version 3, author demo-clinician-tomas)
   v2: status superseded; its officer signature stays in the history (1 stored)
   v3: status awaiting_officer, 0 signatures, modelSha a4c0e9d27b45...
   gates: The program officer can sign now. The clinician can sign once the program officer has signed. The form can be built once both have signed.
   OK: old version superseded, new version starts with zero signatures
   clinician signs v3 first: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   OK: refused: the officer signs first (AR-03)
   officer role sent to the clinician endpoint: HTTP 403 role_mismatch - This endpoint is for the clinician signature; the request says program_officer
   OK: refused: role does not match the endpoint
   officer signs v3: HTTP 201 awaiting_clinician
   OK: officer signature recorded
   demo-officer-amara tries to sign v3 as clinician: HTTP 403 separation_of_duties - The same person cannot sign as program officer and as clinician
   OK: refused: one person cannot sign both roles
   clinician signs v3 quoting the sha of v2: HTTP 409 sha_mismatch - The version's content is not what you reviewed; reload it and review again
   OK: refused: the signature must name exactly the content being signed (AR-07)
   clinician signs v3: HTTP 201 locked
   OK: version LOCKED and run locked (AR-05)

## 6. Compile: refused for the unlocked version, built for the locked one

   [compile] compile refused: release build refused for run pipeline-demo version 2: version 2: is not locked (it needs the program officer's and then the clinician's signature)
   OK: compile of v2 refused (release build refused for run pipeline-demo version 2: version 2: is not locked (it needs the program officer's and then the clinician's signature))
   [compile] compiled cough_fast_breathing release-a4c0e9d2 (release) from run pipeline-demo version 3: 11 files
   [compile] python probe /opt/homebrew/bin/python3 (Python 3.15.2): FAIL ValueError: Cannot use capturing groups in re.Scanner
   [compile] python probe /opt/homebrew/bin/python3.13 (Python 3.13.5): OK
   [compile] cht-conf launcher: node --preserve-symlinks --preserve-symlinks-main <tmp>/cht-tools/node_modules/cht-conf/src/bin/index.js
   [compile] cht convert-app-forms: PASS (exit 0, 0 errors, 0 warnings)
   [compile] cht validate-app-forms: PASS (exit 0, 0 errors, 1 warnings)
   [compile] cht compile-app-settings: PASS (exit 0, 0 errors, 1 warnings)
   [compile] cht-conf: PASS
   OK: compile of v3: pass
   release build release-a4c0e9d2, modelSha a4c0e9d27b45... (equals the signed sha: true)
   cht convert-app-forms: PASS
   cht validate-app-forms: PASS
   cht compile-app-settings: PASS

## 7. Edit after lock: a new version (4) with zero signatures; version 3 stays locked and releasable (AR-09)

   OK: POST versions -> 201 (new version 4, author demo-officer-amara)
   v3: locked; v4: awaiting_officer with 0 signatures; latest releasable version: 3
   OK: locked version untouched; the edit waits for new signatures
   [compile] compile refused: release build refused for run pipeline-demo version 4: version 4: is not locked (it needs the program officer's and then the clinician's signature)
   OK: compile of v4 refused (release build refused for run pipeline-demo version 4: version 4: is not locked (it needs the program officer's and then the clinician's signature))

## 8. Audit (state changes and signatures)

   2026-11-04T09:00:02.000Z run_state {"from":null,"to":"created","filename":"Cough_Guideline.pdf"}
   2026-11-04T09:00:05.000Z run_state {"from":"created","to":"ingesting"}
   2026-11-04T09:00:10.000Z run_state {"from":"ingesting","to":"extracting"}
   2026-11-04T09:00:15.000Z run_state {"from":"extracting","to":"filling_logic"}
   2026-11-04T09:00:22.000Z run_state {"from":"filling_logic","to":"checking"}
   2026-11-04T09:00:28.000Z run_state {"from":"checking","to":"awaiting_officer"}
   2026-11-04T09:00:35.000Z run_state {"from":"awaiting_officer","to":"checking"}
   2026-11-04T09:00:37.000Z run_state {"from":"checking","to":"awaiting_officer"}
   2026-11-04T09:00:39.000Z signature {"n":2,"role":"program_officer","userId":"demo-officer-amara","modelSha":"57aa65f51417a58d609eb77ca3ac443da503f8bc3bb4934616924e1ab64d9c24","settingsSha":"60147227c1ea77a526bf795f928196da71d67074f10fcdcea84b82f71c19b939","inputsSha":"8661edd023b083bb52c4eda64d07711331d3d403cfde3cda4b0a6f9684e1f5b5","checksVersion":"dec020-2","checksNotRun":[]}
   2026-11-04T09:00:40.000Z run_state {"from":"awaiting_officer","to":"awaiting_clinician"}
   2026-11-04T09:00:44.000Z run_state {"from":"awaiting_clinician","to":"checking"}
   2026-11-04T09:00:46.000Z run_state {"from":"checking","to":"awaiting_officer"}
   2026-11-04T09:00:49.000Z signature {"n":3,"role":"program_officer","userId":"demo-officer-amara","modelSha":"a4c0e9d27b45be13530375ca9dfd443647fc7cac14c5d3816c71162df16d0f59","settingsSha":"60147227c1ea77a526bf795f928196da71d67074f10fcdcea84b82f71c19b939","inputsSha":"8661edd023b083bb52c4eda64d07711331d3d403cfde3cda4b0a6f9684e1f5b5","checksVersion":"dec020-2","checksNotRun":[]}
   2026-11-04T09:00:50.000Z run_state {"from":"awaiting_officer","to":"awaiting_clinician"}
   2026-11-04T09:00:54.000Z signature {"n":3,"role":"clinician","userId":"demo-clinician-tomas","modelSha":"a4c0e9d27b45be13530375ca9dfd443647fc7cac14c5d3816c71162df16d0f59","settingsSha":"60147227c1ea77a526bf795f928196da71d67074f10fcdcea84b82f71c19b939","inputsSha":"8661edd023b083bb52c4eda64d07711331d3d403cfde3cda4b0a6f9684e1f5b5","checksVersion":"dec020-2","checksNotRun":[]}
   2026-11-04T09:00:54.000Z version_locked {"n":3,"modelSha":"a4c0e9d27b45be13530375ca9dfd443647fc7cac14c5d3816c71162df16d0f59","settingsSha":"60147227c1ea77a526bf795f928196da71d67074f10fcdcea84b82f71c19b939"}
   2026-11-04T09:00:55.000Z run_state {"from":"awaiting_clinician","to":"locked"}
   2026-11-04T09:00:59.000Z compiled {"n":3,"modelSha":"a4c0e9d27b45be13530375ca9dfd443647fc7cac14c5d3816c71162df16d0f59","settingsSha":"60147227c1ea77a526bf795f928196da71d67074f10fcdcea84b82f71c19b939","bodySha256":"1962ab45d488214376e76bbb09ad44d50a6bf5b1c55ed1a0b7189972894c7b94","checksVersion":"dec020-2","inputsSha":"8661edd023b083bb52c4eda64d07711331d3d403cfde3cda4b0a6f9684e1f5b5","goldenCases":true,"checksNotRun":[],"formVersion":"release-a4c0e9d2","files":11}
   2026-11-04T09:01:02.000Z run_state {"from":"locked","to":"checking"}
   2026-11-04T09:01:04.000Z run_state {"from":"checking","to":"awaiting_officer"}

Overall: every rule held as expected.
