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
| 2 | 0 | 2 |

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


### ERR-002 | Claude Haiku 5.5 rejects the temperature setting
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Extraction (Backend/extraction/run_extraction.py, Backend/src/model/strands.ts)
Severity: high
Symptom (exact error text if short): ValidationException: `temperature` is deprecated for this model.
How to reproduce: Call us.anthropic.claude-haiku-5-5 through Bedrock Converse with inferenceConfig temperature 0 or 0.1. Only temperature 1 is accepted; omitting it works.
Suspected or confirmed cause: Confirmed by direct test calls. Haiku 5.5 does not take a temperature other than the default.
Owner: unassigned
Related: DEC-012, INT-009
Handling: The Python script was fixed by an agent (temperature removed). NOT fixed: Backend/src/model/strands.ts creates BedrockModel with temperature: 0, so the TypeScript extract step will very likely fail the same way for Haiku 5.5 (not run, unverified). Llama 4 Scout accepts temperature 0.1, so the setting must become per model.

## Fixed

### ERR-004 | Bedrock read timeout and reply not starting with text
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Extraction and cross-check scripts
Severity: high
Symptom (exact error text if short): ReadTimeoutError on .../converse after 60 s; then KeyError: 'text' reading the reply.
How to reproduce: Run run_extraction.py with Haiku 5.5 using default boto3 settings.
Suspected or confirmed cause: boto3 waits 60 s for a reply by default and retries automatically, but extraction takes about 86 s. Haiku 5.5 also returns a reasoningContent block before the text block, so reading content[0]["text"] failed.
Owner: Nirubama12
Related: INT-009
Fixed: 2026-11-04
Fixed by: agent (reviewed by Nirubama12 pending)
Fix: Both scripts set read_timeout 900 and no automatic retries (so a slow call is never billed twice); extraction joins all text blocks and records content_block_types in run_metrics.json.
How to prevent a repeat: Always set an explicit read timeout and retry policy on long Bedrock calls; never index content[0]. Note the failed attempts before the fix were billed (at least one Haiku call completed unsaved), so token use across the session is higher than run_metrics.json shows.

### ERR-003 | Llama 4 Scout cannot take the whole document in one call
Found: 2026-11-04 by Nirubama12 (Claude session), via runtime
System: Cross-check (Backend/cross-check/run_extraction.py)
Severity: blocker
Symptom (exact error text if short): "Too many input images: 4, max allowed: 3"; with max tokens 32000: "exceeds the model limit of 8192".
How to reproduce: Send 4 or more page images, or ask for more than 8192 output tokens, to us.meta.llama4-scout-17b-instruct-v1:0 through Converse.
Suspected or confirmed cause: Confirmed by test calls: at most 3 images per request and at most 8192 output tokens. The guideline has 12 pages, and Haiku's output JSON was about 44 KB, so one call per document (DEC-005) cannot work for Llama.
Owner: unassigned
Related: DEC-005, DEC-012, INT-009
Fixed: 2026-11-04
Fixed by: agent (reviewed by Nirubama12 pending), design chosen by human
Fix: Cross-check now sends the pages in batches of 3 (4 calls, run in parallel, 8192 output tokens each) and merges the results in code (see DEC-015). Known cost: edges and links that cross a batch boundary (pages 3-4, 6-7, 9-10) are not produced as edges; go-to links across batches are resolved to the first top-level node of the target page.
How to prevent a repeat: Check a model's image and output limits with tiny calls before designing a prompt around it.
