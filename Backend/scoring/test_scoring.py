"""Tests for the scorer and the eval with a stand-in judge: no AWS, no network.

Run from Backend/scoring:  python3 -m unittest test_scoring -v
"""
import copy
import json
import unittest
from pathlib import Path

from eval_scorer import MUTATIONS, run_eval
from score_version import collect_items, judge_input, page_texts, score_item, score_model

HERE = Path(__file__).parent
MODEL = json.loads((HERE.parent / "tests/fixtures/logic/v1.json").read_text())
BLOCKS = json.loads((HERE.parent / "extraction/input_blocks.json").read_text())
USAGE = {"inputTokens": 100, "outputTokens": 20}


def always(score, ok=None):
    return lambda inp, out: (score, score >= 1.0 if ok is None else ok, "stub", USAGE)


def seq(*scores):
    it = iter(scores)
    return lambda inp, out: (s := next(it), s >= 1.0, "stub", USAGE)


class CollectItems(unittest.TestCase):
    def test_every_quoted_item_is_scored_and_the_rest_listed(self):
        items, skipped = collect_items(MODEL)
        has_quote = lambda x: bool(x.get("source"))
        outs = MODEL["outcomes"]
        parts = ([MODEL["scope"]] + MODEL["questions"] + MODEL["derived"] + outs + MODEL["rules"]
                 + [a for o in outs for a in o["actions"]] + [o["follow_up"] for o in outs if o.get("follow_up")])
        self.assertEqual(len(items), sum(1 for p in parts if has_quote(p)))
        self.assertEqual(len(skipped), sum(1 for p in parts if not has_quote(p)))
        self.assertEqual(len(items) + len(skipped), len(parts))
        self.assertTrue(all("no quote" in s["why"] for s in skipped))

    def test_source_is_not_shown_to_the_judge_as_part_of_the_item(self):
        items, _ = collect_items(MODEL)
        for i in items:
            self.assertNotIn("source", i.output)
            self.assertNotIn("origin", i.output)

    def test_the_judge_sees_the_cited_page_text(self):
        items, _ = collect_items(MODEL)
        q = next(i for i in items if i.path == "questions/convulsions")
        text = judge_input(q, page_texts(BLOCKS))
        self.assertIn('<Page n="5">', text)
        self.assertIn("Convulsions?", text)


class ScoreItem(unittest.TestCase):
    item = collect_items(MODEL)[0][0]

    def test_full_support_is_not_flagged(self):
        r = score_item(self.item, {}, always(1.0), samples=3, threshold=0.7)
        self.assertEqual((r["score"], r["agreement"], r["flag"]), (1.0, 1.0, False))
        self.assertEqual(r["usage"], {"inputTokens": 300, "outputTokens": 60})

    def test_low_score_is_flagged(self):
        r = score_item(self.item, {}, always(0.0), samples=3, threshold=0.7)
        self.assertTrue(r["flag"])
        self.assertIn("below", r["why"])

    def test_disagreement_is_flagged_even_with_a_high_mean(self):
        r = score_item(self.item, {}, seq(1.0, 1.0, 0.5), samples=3, threshold=0.7)
        self.assertAlmostEqual(r["score"], 0.833, places=3)
        self.assertTrue(r["flag"])
        self.assertIn("disagreed", r["why"])

    def test_a_pass_needs_a_full_score(self):
        r = score_item(self.item, {}, always(0.9, ok=True), samples=1, threshold=0.7)
        self.assertFalse(r["samples"][0]["pass"])

    def test_a_judge_that_fails_flags_the_item(self):
        def boom(inp, out):
            raise RuntimeError("throttled")
        r = score_item(self.item, {}, boom, samples=2, threshold=0.7, retries=0)
        self.assertTrue(r["flag"])
        self.assertIsNone(r["score"])

    def test_scores_outside_0_to_1_are_clamped(self):
        r = score_item(self.item, {}, always(7.0, ok=True), samples=1, threshold=0.7)
        self.assertEqual(r["score"], 1.0)


class ScoreModel(unittest.TestCase):
    def test_flagged_items_come_first_and_the_model_is_not_changed(self):
        before = copy.deepcopy(MODEL)
        judge = lambda inp, out: ((0.0, False, "x", USAGE) if '"id": "convulsions"' in out else (1.0, True, "ok", USAGE))
        res = score_model(MODEL, BLOCKS, judge, samples=1, workers=4)
        self.assertEqual(MODEL, before)
        self.assertEqual(res["items"][0]["item"], "questions/convulsions")
        self.assertEqual(res["summary"]["flagged"], 1)
        self.assertEqual(res["summary"]["scored"], len(collect_items(MODEL)[0]))


class Eval(unittest.TestCase):
    def test_every_mutation_changes_its_target_and_nothing_else_scored(self):
        base = {i.path: i for i in collect_items(MODEL)[0]}
        for name, (target, _, fn) in MUTATIONS.items():
            m = copy.deepcopy(MODEL)
            fn(m)
            items = {i.path: i for i in collect_items(m)[0]}
            changed = [p for p in base if (base[p].output, base[p].quotes) != (items[p].output, items[p].quotes)]
            self.assertEqual(changed, [target], name)

    def test_eval_counts_caught_mutations(self):
        # A stand-in judge that only spots the three gap errors.
        bad = {"Advise not to return", "does not need to go", "keep everything down"}

        def judge(inp, out):
            hit = any(b in out for b in bad)
            return (0.0, False, "unsupported", USAGE) if hit else (1.0, True, "ok", USAGE)

        res = run_eval(MODEL, BLOCKS, judge, samples=1, threshold=0.7, workers=4)
        s = res["summary"]
        self.assertEqual((s["gap_errors"], s["gap_caught"]), (3, 3), json.dumps(res["mutations"], indent=1))
        self.assertEqual((s["control_errors"], s["control_caught"]), (5, 0))
        self.assertEqual(s["clean_items_flagged"], 0)
        self.assertIn("3 planted meaning errors that pass the existing checks: 3 flagged", s["slide_line"])


if __name__ == "__main__":
    unittest.main()
