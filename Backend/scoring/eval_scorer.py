"""Offline eval of the quote-support scorer: does it flag planted meaning errors, and how many clean items does it flag?

Each mutation changes ONE item of the clean model so that its quote no longer supports it, while every quote stays
real. The scorer is run on the clean model once and on each mutant. Mutations come in two groups: GAPS pass the
existing deterministic checks (what the judge adds), CONTROL is already blocked by them.

Reported:
- caught: mutations whose target item is flagged (recall on planted errors), per group
- flags on the clean model: each is either a real gap worth a look or a false alarm; a person decides which
- unstable items: items whose samples disagreed on the clean model
- decision load: items flagged (read closely) vs items not flagged (glance at), on the clean model
- tokens used

Usage:
  JUDGE_MODEL_ID=<bedrock id> python3 eval_scorer.py \
      --model ../tests/fixtures/logic/v1.json --blocks ../extraction/input_blocks.json --out eval.json
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

from score_version import Judge, score_model, strands_judge


def _find(xs: list, id_: str) -> dict:
    for x in xs:
        if x.get("id") == id_:
            return x
    raise KeyError(id_)


# name -> (target item path, what the error is, mutate function). Written for the cough_fast_breathing model.
#
# GAPS: meaning errors that pass the deterministic checks (probed with runChecks on tests/fixtures/logic/v1.json,
# real booklet, extraction, golden cases and demo settings, at main 6e73ad9, Nov 4 2026): no blocking finding.
# This is the set that shows what the judge adds.
GAPS: dict[str, tuple[str, str, Callable[[dict], None]]] = {
    "H2_return_advice_negated": (
        "outcomes/treat_fast_breathing_at_home/actions/1",
        "'return immediately if...' became 'do not return unless...' (no finding from the checks)",
        lambda m: _find(m["outcomes"], "treat_fast_breathing_at_home")["actions"][1].__setitem__(
            "text", "Advise not to return unless the child cannot drink or feed, becomes sicker, or has blood in stool."),
    ),
    "H7_referral_explained_away": (
        "outcomes/refer_urgent/actions/0",
        "the urgent referral action says the child does not need to go (no finding from the checks)",
        lambda m: _find(m["outcomes"], "refer_urgent")["actions"][0].__setitem__(
            "text", "Explain why the child does not need to go to the health facility. No referral note is needed."),
    ),
    "H8_vomit_question_reversed": (
        "questions/vomits_everything",
        "'Does the child vomit everything?' became 'Does the child keep everything down?', so yes now means the "
        "opposite (only a warning from the checks, nothing blocks)",
        lambda m: _find(m["questions"], "vomits_everything").__setitem__("label", "Does the child keep everything down?"),
    ),
}

# CONTROL: meaning errors the deterministic checks already block (same probe). Reported separately; they do not
# show the judge's value, only that it agrees with the checks.
CONTROL: dict[str, tuple[str, str, Callable[[dict], None]]] = {
    "S1_real_quote_on_wrong_question": (
        "questions/convulsions",
        "the convulsions question cites the 'vomits everything?' line",
        lambda m: _find(m["questions"], "convulsions").__setitem__("source", {"page": 5, "quote": "vomits everything?"}),
    ),
    "S2_action_reversed": (
        "outcomes/refer_urgent_with_antibiotic/actions/0",
        "the pre-referral antibiotic action now says not to give it, same quote",
        lambda m: _find(m["outcomes"], "refer_urgent_with_antibiotic")["actions"][0].__setitem__(
            "text", "Do not give any antibiotic before referral."),
    ),
    "S3_question_label_changed": (
        "questions/chest_indrawing",
        "the chest indrawing question now asks about a rash",
        lambda m: _find(m["questions"], "chest_indrawing").__setitem__("label", "Look: does the child have a rash?"),
    ),
    "S4_return_advice_softened": (
        "outcomes/treat_fast_breathing_at_home/actions/1",
        "'return immediately' became 'return in 2 weeks'",
        lambda m: _find(m["outcomes"], "treat_fast_breathing_at_home")["actions"][1].__setitem__(
            "text", "Advise to return in 2 weeks if the child becomes sicker."),
    ),
    "S5_outcome_title_contradicts_quote": (
        "outcomes/refer_urgent",
        "the urgent referral result is titled 'treat at home'",
        lambda m: _find(m["outcomes"], "refer_urgent").__setitem__("title", "Danger sign: treat at home"),
    ),
}

MUTATIONS = {**GAPS, **CONTROL}


def run_eval(model: dict, blocks: dict | None, judge: Judge, samples: int, threshold: float, workers: int) -> dict:
    clean = score_model(model, blocks, judge, samples, threshold, workers)
    by_item = {r["item"]: r for r in clean["items"]}
    results = []
    usage = dict(clean["usage"])
    for name, (target, what, fn) in MUTATIONS.items():
        m = copy.deepcopy(model)
        fn(m)
        scored = score_model(m, blocks, judge, samples, threshold, workers)
        usage["inputTokens"] += scored["usage"]["inputTokens"]
        usage["outputTokens"] += scored["usage"]["outputTokens"]
        hit = next((r for r in scored["items"] if r["item"] == target), None)
        before = by_item.get(target)
        results.append({
            "mutation": name, "group": "gap" if name in GAPS else "control", "target": target, "error": what,
            "caught": bool(hit and hit["flag"]),
            "score_clean": before["score"] if before else None,
            "score_mutant": hit["score"] if hit else None,
            "why": hit["why"] if hit else "target item not scored",
            "judge_reason": hit.get("lowest_reason") if hit else None,
        })
    gaps = [r for r in results if r["group"] == "gap"]
    control = [r for r in results if r["group"] == "control"]
    gaps_caught = sum(1 for r in gaps if r["caught"])
    control_caught = sum(1 for r in control if r["caught"])
    clean_flags = [{"item": r["item"], "score": r["score"], "why": r["why"], "judge_reason": r.get("lowest_reason")}
                   for r in clean["items"] if r["flag"]]
    unstable = [r["item"] for r in clean["items"] if r["agreement"] is not None and r["agreement"] < 1.0]
    s = clean["summary"]
    return {
        "summary": {
            "gap_errors": len(gaps), "gap_caught": gaps_caught,
            "control_errors": len(control), "control_caught": control_caught,
            "clean_items_scored": s["scored"], "clean_items_flagged": s["flagged"], "clean_items_not_scored": s["not_scored"],
            "unstable_clean_items": len(unstable),
            "slide_line": (f"{len(gaps)} planted meaning errors that pass the existing checks: {gaps_caught} flagged by the judge. "
                           f"On the clean model the clinician reads {s['flagged']} of {s['scored']} quoted items closely "
                           f"and glances at {s['scored'] - s['flagged']}"),
        },
        "mutations": results,
        "clean_flags": clean_flags,
        "unstable_clean_items": unstable,
        "usage": usage,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--blocks")
    ap.add_argument("--out", required=True)
    ap.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL_ID"))
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-west-2"))
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--temperature", type=float, default=0.5)
    ap.add_argument("--threshold", type=float, default=0.7)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)
    if not a.judge_model:
        ap.error("set --judge-model or JUDGE_MODEL_ID")
    model = json.loads(Path(a.model).read_text())
    blocks = json.loads(Path(a.blocks).read_text()) if a.blocks else None
    t0 = time.time()
    out = run_eval(model, blocks, strands_judge(a.judge_model, a.region, a.temperature), a.samples, a.threshold, a.workers)
    out["run"] = {"judge_model": a.judge_model, "samples": a.samples, "temperature": a.temperature,
                  "threshold": a.threshold, "seconds": round(time.time() - t0, 1)}
    Path(a.out).write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(out["summary"]["slide_line"])
    for r in out["mutations"]:
        print(f"  {'CAUGHT' if r['caught'] else 'MISSED'} [{r['group']}] {r['mutation']}: {r['score_clean']} -> {r['score_mutant']}")
    for f in out["clean_flags"]:
        print(f"  clean flag {f['item']}: {f['why']}")
    print(f"tokens in {out['usage']['inputTokens']} out {out['usage']['outputTokens']}; written: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
