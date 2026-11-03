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
| 0 | 0 | 0 |

Update these counts when you move an entry.

## Pending

No pending errors.

## Fixed

No fixed errors.
