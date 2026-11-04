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
| 1 | 0 | 0 |

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


## Fixed

No fixed errors.
