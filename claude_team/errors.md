# errors.md - Error Tracker

Tracks errors found in review or testing: what is not working, what is fixed, and whether a human or an agent fixed it. Master rules are in [claude.md](claude.md).

Rules for this file:

- One entry per error, with an ID (ERR-NNN) that is never reused.
- New errors go in the Pending section. When fixed, move the entry to the Fixed section and fill in the fix fields. Do not delete entries.
- State plainly whether a human or an agent fixed it.
- Paste only short, relevant error text. No secrets, no personal data, no emoji.

Severity values: blocker, high, medium, low.
Found-by values: review, test, build, runtime, other.
Fixed-by values: human, agent (name the person who reviewed an agent fix).

Entry template:

```
### ERR-NNN | short title
Found: YYYY-MM-DD by person, via review|test|build|runtime
System:
Severity:
Symptom (exact error text if short):
How to reproduce:
Suspected or confirmed cause:
Owner:
Related: INT-NNN, DEC-NNN
--- fill in when fixed ---
Fixed: YYYY-MM-DD
Fixed by: human|agent (reviewed by person)
Fix:
How to prevent a repeat:
```

## Summary

| Pending | Fixed (human) | Fixed (agent) |
|---------|---------------|---------------|
| 5 | 0 | 12 |

Update these counts when you move an entry.

## Pending

### ERR-001 | Source PDF page references off by one
Found: 2026-11-03 by utg1209 (Claude session), via review
System: Guideline intake and extraction (Cough_Guideline.pdf)
Severity: low
Symptom (exact error text if short): p7 "To give first dose oral medication, see page 10" and p9 "Help caregiver give first dose now. (Go to page 10.)"; page 10 is the ORS page, oral medicine instructions are on page 11. Similar for "To give ORS solution, see page 9" (ORS is on page 10).
How to reproduce: Open Guideline_Docs/Cough_Guideline.pdf, follow the page links on pages 7 and 9.
Suspected or confirmed cause: The booklet's printed page links do not match its page numbers in this PDF (probably an editing or pagination difference in the source).
Owner: unassigned
Related: DEC-005, INT-002
Handling: extraction records it as unclear item u1 and resolves the goto to the page 11 node; a reviewer confirms in the UI.


### ERR-012 | Claude Haiku 5.5 rejects the temperature setting
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Extraction (Backend/extraction/run_extraction.py, Backend/src/model/strands.ts)
Severity: high
Symptom (exact error text if short): ValidationException: `temperature` is deprecated for this model.
How to reproduce: Call us.anthropic.claude-haiku-5-5 through Bedrock Converse with inferenceConfig temperature 0 or 0.1. Only temperature 1 is accepted; omitting it works.
Suspected or confirmed cause: Confirmed by direct test calls. Haiku 5.5 does not take a temperature other than the default.
Owner: unassigned
Related: DEC-021, INT-015
Handling: The Python script was fixed by an agent (temperature removed). Backend/src/model/strands.ts is now fixed too: temperatureSetting() sends no temperature to Claude Haiku 5.5 and 0 to every other model (test in tests/model/strands.test.ts). NOT fixed: AgentService/src/agent.ts still sets temperature 0 and will fail the same way if Haiku 5.5 is ever its model (not run).

### ERR-015 | A real Haiku extraction cannot go through fill_logic: the child age variable has no unit
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Extraction prompt and fill resolver (Backend/src/logic/fill/resolve.ts)
Severity: high
Symptom (exact error text if short): fill_logic: the model draft still has 3 problem(s) after one repair: The extraction has no child age variable (unit months), so the age range the form covers cannot be set.; Derived "fast_breathing" definition: threshold 2 applies to an age band ("2 months up to 12 months") but there is no age question.
How to reproduce: Run fill_logic on the real Haiku 5.5 extraction of CoughGuideline2.pdf.
Suspected or confirmed cause: Confirmed. The real extraction records var_child_age with unit null (type "age range"), because the booklet states the unit only inside the age bands. The resolver requires an age variable whose unit is months; the committed sample extraction (made in a session) had unit months written in, so this never showed before.
Owner: unassigned
Related: DEC-005, DEC-017, INT-020
Handling: Not fixed. The sample run used a repaired copy in /tmp (unit set to months). The team decides: let the resolver read the unit from the age bands, or have the extraction prompt set the unit when every band is in months.

### ERR-016 | A real Llama extraction does not satisfy the extraction schema
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Cross-check extraction (Backend/cross-check/run_extraction.py)
Severity: high
Symptom (exact error text if short): Extraction output does not match the extraction schema: nodes.1.kind: Invalid option; nodes.8.goto_target: expected string, received undefined; nodes.20.text: expected string, received null (7 problems in all).
How to reproduce: Parse Backend/cross-check output of a real Llama run with Backend/src/steps/extractionSchema.ts.
Suspected or confirmed cause: Confirmed. Llama omitted goto_target on 4 nodes instead of writing null, wrote null text on 2 nodes and invented the node kind "overview". The Haiku extraction passes the same schema. The Python script does not validate, so the problem only shows when the output is read by the TypeScript code.
Owner: unassigned
Related: DEC-024, INT-020
Handling: Not fixed. The sample run used a repaired copy in /tmp. Options: validate in the cross-check script and normalise a missing goto_target to null; tighten the prompt for Llama.

### ERR-017 | Llama cannot draft a valid logic model with the current fill prompt
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: fill_logic with Llama 4 Scout (Backend/src/steps/fillLogic.ts, Backend/extraction/fill_prompt.txt)
Severity: high
Symptom (exact error text if short): max tokens above the model limit of 8192 (fill default is 16000); then the reply wrapped in a code fence is refused; with the fence removed, 20 schema problems after the repair call (null written for optional keys, a condition in the wrong shape).
How to reproduce: Run createFillLogicStep with modelId us.meta.llama4-scout-17b-instruct-v1:0 on a valid extraction.
Suspected or confirmed cause: Confirmed on one live run. Llama writes null for optional keys, which the strict draft schema forbids, wraps JSON in code fences, which the parser refuses on purpose (tests/model/modelClient.test.ts), and the fill step asks for more output tokens than Llama allows unless maxTokens is set.
Owner: unassigned
Related: DEC-024, DEC-027, INT-020
Handling: Not fixed. No second logic model can be produced by Llama today, so the sample run compared Haiku's real logic model with the hand-written reference v1.json instead. Options: a Llama-specific prompt and normalisation of nulls before validation; use another model for the second draft.

## Fixed

### ERR-002 | Older locked version could be released after a newer one locked
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Compile guard (Backend/src/signoff/signoff.ts verifyLocked)
Severity: high
Symptom (exact error text if short): compileLockedVersion built v1 after v2 was locked (red team 3, A2).
How to reproduce: Lock v1, save and lock v2, compile v1.
Suspected or confirmed cause: verifyLocked only checked that n itself was locked.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: verifyLocked refuses any n that is not the newest locked version (409 not_latest_locked); a newer unsigned draft still does not block (AR-09).
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-003 | Planted or stale findings artifact opened every gate
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Sign-off checks (Backend/src/signoff/checks.ts)
Severity: blocker
Symptom (exact error text if short): A findings file with gates all true let the officer and clinician sign a draft with 12 blockers and built it (A3).
How to reproduce: Write a record with gates true and findings [] at the findings key, then sign and compile.
Suspected or confirmed cause: ensureFindings trusted the stored record and its gate booleans.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: Stored records are zod-validated and their gates recomputed from the findings, for the views only; sign, reject and verifyLocked rerun the checks. CHECKS_VERSION and the inputs sha are part of the key. The false comment in rules.ts was corrected.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-004 | Separation of duties beaten by userId variants
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Sign-off identity (schemas, signoff, rules, both stores)
Severity: high
Symptom (exact error text if short): "alice" as officer and "Alice", " alice", alice plus a zero-width space, or fullwidth letters as clinician locked the version (A1).
How to reproduce: Sign as officer with alice and as clinician with a variant.
Suspected or confirmed cause: userIds were compared byte for byte.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: signoff/identity.ts normalises (NFKC, format characters removed, trim, lower case) and restricts the characters; every comparison and every stored signature uses the normalised id. Seam comment for the Cognito sub.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-005 | Clinician open questions settled by deleting them or writing x
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Open-question check (Backend/src/validation/checks/openQuestions.ts)
Severity: blocker
Symptom (exact error text if short): Removed questions, resolution "x" and resolved-without-resolution all opened the clinician gate (A4).
How to reproduce: Resolve or remove the clinician questions in a version and run the checks.
Suspected or confirmed cause: The check looked only at the current version and treated a missing answer as a warning.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: Trivial or missing answers block; with the version chain, removed, rerouted and wrong-role answers block, and a clinician answer needs the clinician name and a change note. Version.authorRole is recorded at save.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-006 | Unsigned compile settings changed the release output
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Compile guard and check inputs
Severity: high
Symptom (exact error text if short): taskWindowDays 365 and flowMode full built a different tasks.js under the same signed sha and manifest key (A6); production checks ran without golden cases or settings.
How to reproduce: Lock a version, compile twice with different settings.
Suspected or confirmed cause: Settings were neither checked nor bound to the signatures.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: Golden cases and settings are check inputs in production (signoff/checkInputs.ts); signatures carry settingsSha; a build with other settings is refused; the manifest key and audit carry settingsSha.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-007 | compileSnapshot accepted hand-made lock evidence
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Compiler (Backend/src/compiler/compileSnapshot.ts)
Severity: blocker
Symptom (exact error text if short): A release of a draft with blockers was built from a forged LockEvidence object with no store (A5).
How to reproduce: Call compileSnapshot with buildKind release and an approval object.
Suspected or confirmed cause: The release path checked only the shape of caller-supplied evidence and never ran the checks.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: Caller-built evidence is refused; a release names the stored version and goes through releaseBuild, which runs verifyLocked with fresh checks.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-008 | Save accepted a false lineage and reported plain success when checks failed
Found: 2026-11-04 by red team 3 (Claude session), via test
System: API save (Backend/src/api/server.ts) and sign-off
Severity: medium
Symptom (exact error text if short): meta.version 99 / parent_version 42 saved as n=2; onVersionSaved throwing still answered 201 {n} (A8c, A8d); a save during a lease left the run in awaiting_clinician with 0 signatures on the newest version.
How to reproduce: POST a version with mismatched meta; make onVersionSaved throw; save while another lease is held.
Suspected or confirmed cause: No lineage check; the error was only logged; the run state was never reconciled.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: 422 version_mismatch; 201 with checks_status failed; a failed check leaves the run failed at the checks step (resume retries); status, sign and reject heal a stuck run state.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-009 | No way to reject a version
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Sign-off (AR-06, RR-02)
Severity: medium
Symptom (exact error text if short): The clinician could only sign or wait.
How to reproduce: n/a
Suspected or confirmed cause: Not built in INT-011.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: POST /runs/:id/versions/:n/reject with a required comment, itemRef and urgent; status rejected, never signable or buildable; Infra route and tests.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-010 | Locked version body could be rewritten in fields outside modelSha
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Compile guard
Severity: medium
Symptom (exact error text if short): change_note, created_by and created_at rewritten in S3 after the lock still built (A9a).
How to reproduce: Overwrite the locked artifact with only those fields changed and compile.
Suspected or confirmed cause: modelSha leaves them out and the bytes were not recorded.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: Version.bodySha256 is recorded at save; sign and verifyLocked refuse when the stored bytes differ, and a release refuses a version with no record.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-011 | Signers not told which checks did not run
Found: 2026-11-04 by red team 3 (Claude session), via test
System: Sign-off checks
Severity: medium
Symptom (exact error text if short): Golden-case and form-readiness checks were skipped in production with only an information item.
How to reproduce: Run the checks without golden cases or settings.
Suspected or confirmed cause: computeFindings passed neither input; nothing in the gates said so.
Owner: utg1209 (Claude session)
Related: DEC-019, DEC-020, INT-012
--- fill in when fixed ---
Fixed: 2026-11-04
Fixed by: agent (Claude session; to be reviewed by utg1209)
Fix: checksNotRun on the record, the findings view, the status, the sign result and the 422 body, and a "Not checked:" sentence in the gate summary.
How to prevent a repeat: Backend/tests/signoff/hardening.test.ts and the red-team harness.

### ERR-014 | Bedrock read timeout and reply not starting with text
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Extraction and cross-check scripts
Severity: high
Symptom (exact error text if short): ReadTimeoutError on .../converse after 60 s; then KeyError: 'text' reading the reply.
How to reproduce: Run run_extraction.py with Haiku 5.5 using default boto3 settings.
Suspected or confirmed cause: boto3 waits 60 s for a reply by default and retries automatically, but extraction takes about 86 s. Haiku 5.5 also returns a reasoningContent block before the text block, so reading content[0]["text"] failed.
Owner: Nirubama12
Related: INT-015
Fixed: 2026-11-04
Fixed by: agent (reviewed by Nirubama12 pending)
Fix: Both scripts set read_timeout 900 and no automatic retries (so a slow call is never billed twice); extraction joins all text blocks and records content_block_types in run_metrics.json.
How to prevent a repeat: Always set an explicit read timeout and retry policy on long Bedrock calls; never index content[0]. Note the failed attempts before the fix were billed (at least one Haiku call completed unsaved), so token use across the session is higher than run_metrics.json shows.

### ERR-013 | Llama 4 Scout cannot take the whole document in one call
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Cross-check (Backend/cross-check/run_extraction.py)
Severity: blocker
Symptom (exact error text if short): "Too many input images: 4, max allowed: 3"; with max tokens 32000: "exceeds the model limit of 8192".
How to reproduce: Send 4 or more page images, or ask for more than 8192 output tokens, to us.meta.llama4-scout-17b-instruct-v1:0 through Converse.
Suspected or confirmed cause: Confirmed by test calls: at most 3 images per request and at most 8192 output tokens. The guideline has 12 pages, and Haiku's output JSON was about 44 KB, so one call per document (DEC-005) cannot work for Llama.
Owner: unassigned
Related: DEC-005, DEC-021, INT-015
Fixed: 2026-11-04
Fixed by: agent (reviewed by Nirubama12 pending), design chosen by human
Fix: Cross-check now sends the pages in batches of 3 (4 calls, run in parallel, 8192 output tokens each) and merges the results in code (see DEC-024). Known cost: edges and links that cross a batch boundary (pages 3-4, 6-7, 9-10) are not produced as edges; go-to links across batches are resolved to the first top-level node of the target page.
How to prevent a repeat: Check a model's image and output limits with tiny calls before designing a prompt around it.
