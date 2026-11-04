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

   modelSha 161b103ca759...; claim PROVEN; 18 blocking, 7 warning, 26 info
   gates: The program officer cannot sign yet. Still to settle: 5 unanswered open questions. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 unanswered open questions. The form cannot be built yet: 18 items still block.
   program_officer: 5 blocking item(s) for them to settle, for example:
     - Open question Q7 has not been answered: How many days should the follow-up task stay open after it is due? The guideline gives the due day only. It concerns tre
     - Open question Q2 has not been answered: The guideline sends the health worker to page 10 to give the first dose of oral medicine, but page 10 is the ORS page an
     - Open question Q13 has not been answered: These items have no supporting quote from the guideline and are the team's wording or choice: cough_no_fast_breathing, 
   clinician: 13 blocking item(s) for them to settle, for example:
     - Test case g09 ("1 month, no cough") cannot be run: it expects a result ("refer_outside_age_range") that the draft does not have. Nothing has been checked for th
     - Test case g15 ("KNOWN HAZARD: 1 month old with convulsions") cannot be run: it expects a result ("refer_outside_age_range") that the draft does not have. Nothin
     - Test case g08 ("60 months, no cough") cannot be run: it expects a result ("refer_outside_age_range") that the draft does not have. Nothing has been checked for 

## 3. Signing is BLOCKED while blockers exist; compile is REFUSED for an unsigned version

   officer signs v1: HTTP 422 blocked - The program officer cannot sign yet. Still to settle: 5 unanswered open questions. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 unanswered open questions. The form cannot be built yet: 18 items still block.
   OK: officer refused with 422 blocked (5 blockers listed)
   clinician signs v1: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   OK: clinician refused with 409: the officer signs first
   [compile] compile refused: release build refused for run pipeline-demo version 1: version 1: is not locked (it needs the program officer's and then the clinician's signature)
   OK: compile of v1 refused (release build refused for run pipeline-demo version 1: version 1: is not locked (it needs the program officer's and then the clinician's signature))

## 4. Second pass: the program officer fixes their items (new version 2)

   OK: POST versions -> 201 (new version 2, author demo-officer-amara)
   v2: status awaiting_officer, run awaiting_officer, modelSha 6ca3d597b644...
   gates: The program officer cannot sign yet. Still to settle: 5 open questions answered by the wrong person. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 unanswered open questions. The form cannot be built yet: 18 items still block.
   UNEXPECTED: officer can sign, clinician still blocked
   officer signs v2: HTTP 422 blocked - The program officer cannot sign yet. Still to settle: 5 open questions answered by the wrong person. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 unanswered open questions. The form cannot be built yet: 18 items still block.
   UNEXPECTED: officer signature recorded; waiting for the clinician
   clinician signs v2: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   UNEXPECTED: clinician refused with 422: 0 open question(s) routed to the clinician

## 5. The clinician answers their questions (new version 3): signatures start over (AR-04)

   OK: POST versions -> 201 (new version 3, author demo-clinician-tomas)
   v2: status superseded; its officer signature stays in the history (0 stored)
   v3: status awaiting_officer, 0 signatures, modelSha b6450add01d9...
   gates: The program officer cannot sign yet. Still to settle: 5 open questions answered by the wrong person. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 open questions answered by the wrong person. The form cannot be built yet: 18 items still block.
   OK: old version superseded, new version starts with zero signatures
   clinician signs v3 first: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   OK: refused: the officer signs first (AR-03)
   officer role sent to the clinician endpoint: HTTP 403 role_mismatch - This endpoint is for the clinician signature; the request says program_officer
   OK: refused: role does not match the endpoint
   officer signs v3: HTTP 422 blocked - The program officer cannot sign yet. Still to settle: 5 open questions answered by the wrong person. The clinician cannot sign yet: this waits for the program officer's signature, and these are for the clinician: 4 test cases that cannot be run; 9 open questions answered by the wrong person. The form cannot be built yet: 18 items still block.
   UNEXPECTED: officer signature recorded
   demo-officer-amara tries to sign v3 as clinician: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   UNEXPECTED: refused: one person cannot sign both roles
   clinician signs v3 quoting the sha of v2: HTTP 409 sha_mismatch - The version's content is not what you reviewed; reload it and review again
   OK: refused: the signature must name exactly the content being signed (AR-07)
   clinician signs v3: HTTP 409 officer_signature_required - The program officer signs first (AR-03)
   UNEXPECTED: version LOCKED and run locked (AR-05)

## 6. Compile: refused for the unlocked version, built for the locked one

   [compile] compile refused: release build refused for run pipeline-demo version 2: version 2: is not locked (it needs the program officer's and then the clinician's signature)
   OK: compile of v2 refused (release build refused for run pipeline-demo version 2: version 2: is not locked (it needs the program officer's and then the clinician's signature))
   [compile] compile refused: release build refused for run pipeline-demo version 3: version 3: is not locked (it needs the program officer's and then the clinician's signature)
   UNEXPECTED: compile of v3: refused

## 7. Edit after lock: a new version (4) with zero signatures; version 3 stays locked and releasable (AR-09)

   OK: POST versions -> 201 (new version 4, author demo-officer-amara)
   v3: superseded; v4: awaiting_officer with 0 signatures; latest releasable version: null
   UNEXPECTED: locked version untouched; the edit waits for new signatures
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
   2026-11-04T09:00:42.000Z run_state {"from":"awaiting_officer","to":"checking"}
   2026-11-04T09:00:44.000Z run_state {"from":"checking","to":"awaiting_officer"}
   2026-11-04T09:00:54.000Z run_state {"from":"awaiting_officer","to":"checking"}
   2026-11-04T09:00:56.000Z run_state {"from":"checking","to":"awaiting_officer"}

Overall: 8 UNEXPECTED result(s):
- step 4: officer can sign, clinician still blocked
- step 4: officer signature recorded; waiting for the clinician
- step 4: clinician refused with 422: 0 open question(s) routed to the clinician
- step 5: officer signature recorded
- step 5: refused: one person cannot sign both roles
- step 5: version LOCKED and run locked (AR-05)
- step 6: compile of v3: refused
- step 7: locked version untouched; the edit waits for new signatures
