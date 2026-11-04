# BRD: No-Code CHT Configuration


AWS Breaking Barriers 2026, Seattle. Customer: Medic, steward of the Community Health Toolkit (CHT). Track: Open path.

Live, editable copy: https://claude.ai/artifact/7SfBbuHjcJHHFz9nSaA4c5 (if the two differ, the live doc is newer; update this file to match).

## How to use this document

This BRD records the business context and the design rules the team and Medic agreed on November 3, 2026. Medic's POC confirmed them in person. Medic's two documents, the Vision Document (`vision-document-no-code-cht-configuration.md`) and the Technical Environment Document (`technical-environment-document-no-code-cht-configuration.md`), give the wider context.

**Working with this BRD**

- Change it only by team agreement. Record every change in the change log at the end.
- Rules in the approval, release and guardrail sections are non-negotiable. Never weaken them to save time.
- Cite the ID when building or testing against a requirement, such as "implements BR-05" or "tests AR-08".
- Never fill a gap with a guess. If the BRD doesn't answer something, add it to the open questions.

**Source tags**

| Tag | Meaning |
| --- | --- |
| Medic doc | From Medic's Vision or Technical Environment Document |
| Medic, Nov 3 | Said by Medic or the clinician in person on November 3, 2026 |
| Team | Decided by our team on November 3, 2026 |

**ID scheme**

| Prefix | Section |
| --- | --- |
| BR | Business requirements |
| AR | Approval and versioning rules |
| RR | Release rules |
| GR | Guardrails |
| OQ | Open questions |

## 1. Background and business problem

**Context**

- The CHT serves 182,000+ community health workers in 24 countries. Eight governments run it as their national community health platform. (Medic doc)
- The CHT is a toolkit. Each deployment is configured for a specific use case, and different locations have different configurations. (Medic, Nov 3)
- Program officers and clinicians have no user interface for configuration today. (Medic, Nov 3)
- Use cases go beyond clinical pathways. For example, a government asked for inventory management. (Medic, Nov 3)
- The ministry owns the product, and its data storage stays local. (Medic doc; Medic, Nov 3)
- Medic's long-term dream is going from health diagrams straight to configuration. (Medic, Nov 3)
- Medic wants to learn how fast an AI-native team can build this. (Medic, Nov 3)

**How a change happens today** (Medic doc, with detail from Medic, Nov 3)

1. Raw input arrives: voice guidance, handwritten clinician notes, interviews with health officials, rough sketches, or a formal health document. It is sometimes in the local language.
2. A service designer writes down the constraints and maps them to what the app can hold.
3. The design becomes a Figma document.
4. The program officer builds the form flow.
5. The clinician reviews it and sends comments by email. The form builder fixes it and sends it back. This repeats until the clinician is satisfied.
6. An app developer configures the form in XLSForm.
7. A tech person uploads it, and health workers' phones receive it on their next sync.

**Pain points**

| # | Pain point | Source |
| --- | --- | --- |
| P1 | A label fix is about five minutes of work, yet it waits for the full cycle. Changes take weeks to months to reach health workers. | Medic doc |
| P2 | Developers are few and backlogs are full, so many changes are never made. | Medic doc |
| P3 | Clinician feedback travels by email, and every correction is a round trip. | Medic, Nov 3 |
| P4 | Many non-technical people each handle one step. Nobody owns the whole change. | Medic, Nov 3 |
| P5 | Developers can misread clinical intent, which leads to rounds of test and repair. | Medic doc |
| P6 | Errors pass every existing check. A dropped pair of brackets would have widened who sees 11 of 24 forms. It slipped in after clinician approval, at the build and deployment stage, because no good test harness existed. | Medic doc; Medic, Nov 3 |

**Business question**

How can a ministry change its own health worker workflows in days, without a developer, while every change stays clinically safe?

## 2. Objectives and success measures

**Business objectives**

1. Let a program officer turn a guideline into a working health worker form without a developer. (P1, P2, P4)
2. Cut the clinician correction loop from days of email to minutes inside one tool. (P3)
3. Prove each change is safe before it reaches health workers, including mistakes made at the build stage. (P5, P6)

**Success measures for the day 3 demo**

| Measure | Target | How we measure | Source |
| --- | --- | --- | --- |
| Time from guideline upload to IT release | Minutes, not counting time spent waiting for people | Time recorded for each step, compared with today's process in Medic's video | Medic doc; Team |
| Branches tested | Every branch of the pathway has at least one synthetic patient, and every outcome matches | Test report | Medic doc |
| Golden cases | All match, or each mismatch is shown before approval | Golden-case report | Medic doc |

**Medic's targets after the event** (Medic doc)

- A requested change reaches health workers in days, not weeks or months.
- Most routine edits are made without a developer.
- Every change passes review and validation before deployment.

## 3. Scope

**In scope for the MVP**

- One guideline: WHO/UNICEF iCCM, *Caring for the sick child in the community*. (Team)
- One pathway: child cough and fast breathing. (Team; Medic, Nov 3, left the choice to us)
- One program officer, one clinician and one IT person, as separate people. (Medic, Nov 3)
- One person editing at a time. (Medic, Nov 3)
- A visual interface for non-technical users is non-negotiable. (Medic, Nov 3)
- The logic model is designed for this one workflow only, not as a general format. (Medic, Nov 3)
- AI drafts the pathway from the guideline into an editable table. (Medic doc; Team)
- A read-only flowchart view, and a view of what changed between versions. (Team; Medic, Nov 3)
- Clinician edits directly in the table. (Medic, Nov 3)
- Two-person sign-off on every version, with full version history. (Team; Medic, Nov 3)
- Validation of the logic, field constraints, golden cases, and synthetic-patient tests of the built form. (Medic doc; Medic, Nov 3)
- Two release paths: urgent and standard. (Team)
- Release to a test CHT instance, not a live one. (Medic, Nov 3)
- A look that matches Medic's style kit. (Medic, Nov 3)
- A timed demo compared with Medic's video of today's process. (Medic, Nov 3)

**Stretch**

- An editable flowchart. Medic said an editable table and flowchart "is great." The table comes first. (Medic, Nov 3)

**Out of scope**

| Item | Reason |
| --- | --- |
| Generalizing beyond one guideline | Medic said it needs health officials involved. We are not judged on it. (Team; Medic, Nov 3) |
| National-to-local cascading of changes | Not required first. (Medic, Nov 3) |
| Rollback | Not needed for the MVP. History is kept, so it can be added later. (Team) |
| Clinician-started change requests | A goal after the MVP. (Medic, Nov 3) |
| Access management | After the MVP. (Medic, Nov 3) |
| Program officer and clinician as the same person | After the MVP. (Medic, Nov 3) |
| Several people editing at once | One person at a time in the MVP. (Medic, Nov 3) |
| Plain-language error messages from the build or release stage | Out of scope for now; a triage agent later. (Medic, Nov 3) |
| Modeling offline behavior | We build the build-time tool. Offline matters only on phones. (Medic, Nov 3) |
| Raw inputs: voice, handwritten notes, Figma, local language | The MVP starts from a guideline document. (Team) |
| Translations | Out of scope for the event. (Medic doc) |
| Production deployment, real patient data, AI on health workers' phones | Event rules and clinical safety. (Medic doc) |
| More than one pathway, targets and dashboards | Out of scope for the event. (Medic doc) |

## 4. Users and roles

All three users are non-technical. None of them should ever need to read XLSForm, XPath or JavaScript. (Medic doc)

| Role | What they do in the tool | What they cannot do |
| --- | --- | --- |
| Program officer (played by the officer agent, DEC-024) | Reviews the AI draft. Fixes citations and file details. Answers only the open questions routed to the program officer. Signs each version first, as the officer agent. A person uploads the guideline and picks the pathway. | Release to IT. Change rules, thresholds, outcomes or action text. Answer clinician questions. Sign a version the clinician hasn't seen after it. |
| Clinician (the only human approver) | Reviews the table and flowchart. Edits the tree through a closed set of edits with a preview. Rejects with a comment on a specific rule. Signs each version second. Marks a change as urgent. | Sign before the officer. Start a change request (after the MVP). |
| IT | Sees signed versions, what changed, and the test report. Releases to the CHT instance. | Edit the logic. Approve clinical content. |

**Separation of duties**

- No one person drafts, approves and deploys a clinical change. (Medic doc)
- The app developer can't validate a clinician's change. (Medic, Nov 3)
- In the MVP, the program officer and the clinician are always different people. (Medic, Nov 3)
- At the event, Medic plays the clinician. Our team plays the program officer and IT. (Medic doc; Team)

## 5. Business requirements

All are Must unless marked otherwise.

**Guideline input and AI draft**

| ID | Requirement | Source |
| --- | --- | --- |
| BR-01 | The program officer uploads a guideline document and picks one pathway. | Medic doc; Team |
| BR-02 | The AI drafts the pathway's questions, decision rules and follow-up timing into the table. | Medic doc |
| BR-03 | Every rule and question shows the guideline page and passage it came from. | Medic doc |
| BR-04 | Unclear or contradictory passages are flagged for a person to resolve. They are never resolved silently. | Medic doc |

**Editor and views**

| ID | Requirement | Source |
| --- | --- | --- |
| BR-05 | The table is the only editable view. Every other view is drawn from it. | Team |
| BR-06 | A read-only flowchart view always matches the current table. Editing the flowchart is a stretch goal. | Team; Medic, Nov 3 |
| BR-07 | In the table, users can also set what the form needs beyond the rules: question order, when each question appears, field type (text, number, dropdown), and entry limits. | Team (layout to confirm, see OQ-02) |
| BR-08 | Users can toggle to see what changed between two versions. | Medic, Nov 3 |
| BR-09 | Our builder's own screens can look however suits non-technical users. The output and its visuals should look like what officers and clinicians already know, following the style kit in Medic's service design docs, so nobody needs retraining. Reference configurations: github.com/medic/cht-core/tree/master/config. | Medic, Nov 3 |
| BR-10 | Only one person edits at a time. Others see that the version is being edited. | Medic, Nov 3 |

**Validation and testing**

| ID | Requirement | Source |
| --- | --- | --- |
| BR-11 | Before anyone signs, automatic checks flag gaps, overlapping rules, unreachable rules, a missing catch-all, and numbers that don't match the guideline passage. | Medic doc; Team |
| BR-12 | About 12 golden cases, written from the guideline, test the logic. We design them by following Medic's service design workflow. Medic helps verify them, including their labels. | Medic doc; Medic, Nov 3 |
| BR-13 | Field constraints limit what a health worker can enter, such as breaths per minute being a number in a sensible range. | Medic, Nov 3 |
| BR-14 | The built form is tested with synthetic patients that cover every branch. Expected outcomes come from the signed table. This catches build-stage mistakes like the bracket bug (P6). | Medic doc; Medic, Nov 3 |
| BR-15 | IT sees the test report and what changed before releasing. | Medic doc |

**Clinician**

| ID | Requirement | Source |
| --- | --- | --- |
| BR-16 | The clinician can edit the table directly. | Medic, Nov 3 |
| BR-17 | The clinician can reject a version with a comment attached to a specific rule. | Team |
| BR-18 | Should: a check flags clinician comments too vague to act on, so the officer can ask for clarity. | Medic, Nov 3 |

**Release, records and timing**

| ID | Requirement | Source |
| --- | --- | --- |
| BR-19 | Releases go to a test CHT instance, not a live one. | Medic, Nov 3 |
| BR-20 | Every version records who drafted, edited, signed and released it, and when. | Medic doc; Team |
| BR-21 | The time for each step is recorded, from guideline upload to release. | Team |

## 6. Approval and versioning rules

Non-negotiable. Every rule must be testable, and the demo must show them holding. (Team; Medic, Nov 3, confirmed "our logic is right")

| ID | Rule |
| --- | --- |
| AR-01 | Every edit creates a new version, whoever makes it. No exceptions. A version is never changed in place. |
| AR-02 | A new version starts with zero signatures. |
| AR-03 | The officer agent signs first, as the program officer (a person cannot sign as program officer). The clinician signs second and is the only human approver. |
| AR-04 | If the clinician edits, a new version is created. It goes back to the officer agent to check and sign, then to the clinician. |
| AR-05 | Once both have signed, the version is locked and can never be edited. |
| AR-06 | If the clinician rejects, the version returns to the officer agent (which escalates what it may not fix) with the clinician's comment on the specific rule. The rejected version stays in the history and can never be released. The officer's fix is a new version. |
| AR-07 | A signature applies to one exact version. What the signers saw is exactly what gets built. |
| AR-08 | Only a version with both signatures can go to IT. |
| AR-09 | Only the most recent signed version can be released. A newer unsigned draft never blocks it. |
| AR-10 | All versions, including rejected ones, are kept with their full history. |

**Example** (cough pathway)

- v3 is signed by both and goes to IT.
- The officer edits a threshold, creating v4 with zero signatures. v3 can still be released.
- The officer signs v4. While reviewing it, the clinician changes 50 breaths to 45, creating v5. The officer signs v5, then the clinician signs it.
- v5 is now the most recent signed version. Only v5 can be released, not v3.

## 7. Release rules

| ID | Rule | Source |
| --- | --- | --- |
| RR-01 | There are two release paths. Urgent: changes that affect patients go out right after they pass the tests. Standard: other changes wait in a queue and go out together after a period the ministry sets. | Team |
| RR-02 | The clinician marks a change as urgent when signing, because urgency is a clinical judgment. | Team |
| RR-03 | Urgent changes skip only the waiting time. They still need both signatures and must pass every test. | Team |
| RR-04 | Nothing is released unless the built form passes the synthetic-patient tests (BR-14). | Medic doc |
| RR-05 | A person in IT approves each release after seeing what changed and the test report. The IT step should be fast; an agent may prepare the release. | Medic doc; Medic, Nov 3 |
| RR-06 | Should: before a standard batch goes out, the officer is asked whether more changes should join it. Health workers may travel long distances, so fewer, larger updates help. | Medic, Nov 3 |
| RR-07 | There is no rollback in the MVP. Faster releases must still be stable. (Medic, Nov 3) | Team |

**Known risk, no fix in the MVP:** two health workers can end up on different versions, depending on who syncs first. (Medic, Nov 3)

## 8. Guardrails

Non-negotiable. GR-01 to GR-10 restate Medic's ten design rules in plain words. Breaking any of them fails Medic's Definition of Done.

| ID | Guardrail | Source |
| --- | --- | --- |
| GR-01 | The AI never writes the configuration that ships. Code builds it from the signed table. | Medic doc |
| GR-02 | Every change gets human approval on content and on release. Clinical changes need a clinician. | Medic doc |
| GR-03 | AI drafts and human edits go through the same checks. | Medic doc |
| GR-04 | Approval applies to one exact version, never to a conversation. | Medic doc |
| GR-05 | What the signers see comes from the same table the build uses. | Medic doc |
| GR-06 | Expected test outcomes come from the signed table. The AI never judges whether a test passed. | Medic doc |
| GR-07 | Unclear guideline passages are flagged for a person, never resolved silently. | Medic doc |
| GR-08 | Synthetic data only. No real patient data or real credentials. | Medic doc |
| GR-09 | Nothing generative runs on a health worker's phone. | Medic doc |
| GR-10 | Output is standard CHT configuration, and every change is recorded. | Medic doc |
| GR-11 | Rejection reasons are kept and fed into later AI drafts, so the AI learns from what failed. | Medic, Nov 3 |

## 9. Demo scenario

The story: today's weeks of handoffs, then the same change in minutes, with safety shown at every step. (Team; Medic, Nov 3)

1. **Today.** Play Medic's video of how a change happens now.
2. **Draft.** The officer uploads the iCCM guideline and picks cough and fast breathing. The AI drafts the table. Each rule shows its source passage, and flagged passages are shown. The officer resolves the flags and signs. (BR-01 to BR-04, BR-11)
3. **Review.** The clinician opens the table and the flowchart. They change one threshold directly, which creates a new version. The officer signs it, then the clinician signs and the version locks. This replaces days of email with minutes. (BR-16, AR-01 to AR-05)
4. **Caught error.** A planted build-stage mistake, like Medic's missing-bracket bug, produces a wrong built form. The synthetic-patient tests catch it before release. (BR-14, RR-04)
5. **Release.** IT sees what changed and the test report, approves, and the form appears in our CHT instance. (BR-15, BR-19)
6. **Speed.** Show the time for each step, next to the weeks in today's process. (BR-21)

Optional if time allows: the urgent release path (RR-01 to RR-03).

## 10. Timeline, assumptions, risks and open questions

**Timeline**

- Two build days, with presentations on day 3. (Medic doc)

**Assumptions**

- The iCCM guideline works for this pathway. Medic left the pathway choice to us. (Medic, Nov 3)
- Medic plays the clinician and helps verify the golden cases. (Medic doc; Medic, Nov 3)
- Medic's style kit can be found in its service design docs and the cht-core config folder. (Medic, Nov 3)
- Medic was open to us building on its UI builder or building our own. We chose our own, on the Open path. (Medic, Nov 3; Team)

**Risks**

| Risk | Mitigation |
| --- | --- |
| The AI misreads the guideline | Source passages, flags, golden cases, and the officer's and clinician's review |
| Building our own editor in two days | Only the table is editable. The flowchart is read-only. |

**Open questions**

| ID | Question | Owner |
| --- | --- | --- |
| OQ-01 | Where exactly is the style kit? Medic mentioned the service design docs and the COVID-19 standard config in cht-core. | Medic |
| OQ-02 | How should the table hold question order, when each question appears, field types and entry limits (BR-07)? | Team |
| OQ-03 | How should a child outside the pathway appear: under 2 months, or 5 years and older? | Clinician |
| OQ-04 | What standard release period should the demo use (RR-01)? | Team |
| OQ-05 | Which criteria will Medic use to pick a build? | Medic |
| OQ-06 | Medic said in person to add more workflows if we finish early. Medic's documents list more than one pathway as out of scope. Is a second pathway a stretch goal? | Team, Medic |
| OQ-07 | Medic said "IT is agentic, so should approve immediately." Medic's documents require a human release approval (RR-05). Can the release step be fully automatic, or does a person still approve? | Medic |
| OQ-08 | Medic must confirm the role change: the program officer's review and signature are done by an officer agent and the clinician is the only human approver (DEC-024). | Medic |

## Change log

| Version | Date | Change | Agreed by |
| --- | --- | --- | --- |
| 1.0 | November 3, 2026 | First version, from the team's and Medic's sessions on November 3 | Team |
| 1.1 | November 3, 2026 | States that this BRD supersedes all earlier planning files | Team |
| 1.2 | November 3, 2026 | Medic's two documents named alongside the BRD. Completeness check added missing context, BR-09 and BR-12 detail, release stability and assumptions | Team |
| 1.3 | November 3, 2026 | Removed technical constraints and the source-of-truth rule. Guardrails and open questions renumbered | Team |
