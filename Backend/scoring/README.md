# Quote-support scorer (Strands Evals)

A second model reads each item of a logic model version next to the booklet quote it cites and scores
whether the quote supports it, from 0 to 1. Low or unsteady scores are flagged so the clinician reads
those first and glances at the rest. This targets decision fatigue: it does not remove any approval.

**Advisory only.** Scores are written to their own JSON file. They are not findings, never block a
signature, never change the model, and are never used on golden cases or synthetic-patient results
(Medic rule 6: a model never judges a test).

## How it works

- Judge: `strands_evals.evaluators.OutputEvaluator` (LLM-as-a-judge) on Amazon Bedrock, with the rubric in
  `score_version.py`. The judge gets the item, its quotes, the full text of the cited pages and context
  (for a rule: the result it leads to and the names of the fields it reads).
- Scored: every part of the model that cites the booklet (scope, questions, derived, outcomes, actions,
  follow-ups, rules). Items with no quote (origin `team`/`clinician`) are listed under `not_scored`.
  On `tests/fixtures/logic/v1.json` at main `6e73ad9` that is 32 scored items (28 on the older six-rule copy).
- Each item is judged 3 times at temperature 0.5. Score = mean; agreement = share of samples matching the
  majority pass/fail. A pass needs a full 1.0. **Flag** when the score is under 0.7 or the samples disagree.
  A judge call that fails flags the item (nothing passes silently).
- Output is sorted flagged first, lowest score first, and carries token usage for the cost record.

## Run

```shell
cd Backend/scoring
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 -m unittest test_scoring -v        # no AWS needed: stand-in judge

export AWS_REGION=us-west-2
export JUDGE_MODEL_ID=<a Bedrock model or us. inference profile ID, not the drafting model>
python3 score_version.py --model ../tests/fixtures/logic/v1.json \
    --blocks ../extraction/input_blocks.json --out scores.json
python3 eval_scorer.py --model ../tests/fixtures/logic/v1.json \
    --blocks ../extraction/input_blocks.json --out eval.json
```

The credentials need `bedrock:InvokeModel` on the judge model. The deployed Lambda's policy
(`Infra/lib/data-stack.ts`) covers `MODEL_ID` only, so running this in AWS needs that policy extended.

## The eval

`eval_scorer.py` scores the clean model, then 8 copies with one planted meaning error each, and reports
whether the changed item was flagged.

- **Gap group (3)**: errors that pass the existing deterministic checks. Probed with `runChecks` on v1 with
  the real booklet, extraction, golden cases and demo settings, at main `6e73ad9`:
  - `H2` "return immediately if..." becomes "do not return unless...": no finding
  - `H7` urgent referral action says the child does not need to go: no finding
  - `H8` "Does the child vomit everything?" becomes "Does the child keep everything down?": warning only
- **Control group (5)**: errors the checks already block (`TEXT_OFF_TOPIC`, `UNGROUNDED_NUMBER`). They show the
  judge agrees with the checks, not what it adds.

It prints one slide line, for example:
"3 planted meaning errors that pass the existing checks: N flagged by the judge. On the clean model the
clinician reads F of 32 quoted items closely and glances at the rest." Each clean-model flag is either a real
gap or a false alarm: look at each one and say which on the slide.

Not done yet: calling this from the API (a `GET /runs/:id/versions/:n/scores` route, Python deps in the
Lambda image, IAM for the judge model) and a confidence column in the review UI.
