# Logic model fixtures

PROPOSED, NOT CLINICALLY CONFIRMED, AWAITING MEDIC.

- `v1.json`: copy of the team's hand-written logic model (repo root v1.json, DEC-017). Golden reference for the parser, interpreter and grid tests.
- `golden-proposed.json`: input/expected-outcome cases derived only from v1.json and the booklet content already in it. Synthetic answers, no patient data. Each case needs clinician review before it is treated as ground truth. Case g05 depends on open question Q1 (12 months), g08, g09 and g15 on Q2 (outside the age range). g15 documents a known hazard: a lower-severity rule fires first.
