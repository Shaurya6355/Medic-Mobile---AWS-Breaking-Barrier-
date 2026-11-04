# Logic model fixtures

PROPOSED, NOT CLINICALLY CONFIRMED, AWAITING MEDIC.

- `v1.json`: copy of the team's final logic model (logic-model/pathways/cough_fast_breathing/v1.json, 7 rules R1 to R7, 7 outcomes; also the git-ignored repo root v1.json). Golden reference for the parser, interpreter and grid tests.
- `golden-proposed.json`: input/expected-outcome cases derived only from v1.json and the booklet content already in it. Synthetic answers, no patient data. Each case needs clinician review before it is treated as ground truth. Case g05 depends on open question Q1 (12 months), g08, g09, g15, g17, g18 and g19 on Q2 (outside the age range). g15 and g17 (1 month old with convulsions or chest indrawing) now expect refer_urgent_outside_age_range through R1: the old hazard, where a lower-severity out-of-range rule fired before the danger-sign rule, is fixed. Every outcome has at least one case. g16 (infant with a danger sign and fast breathing) and g17 pin which of two equally urgent overlapping results a child gets (red team 1, M81): the URGENT_OVERLAP_UNTESTED check asks for such a case.
