"""Run: python3 -m unittest Backend/extraction/test_usage_cost.py  (from the repo root) or in this folder."""
import unittest

from usage_cost import cost_usd


class CostUsd(unittest.TestCase):
    def test_uses_prices_json_for_the_model(self):
        env = {"PRICES_JSON": '{"m1": {"inPerMTok": 3, "outPerMTok": 15}}'}
        self.assertEqual(cost_usd(env, "m1", 1_000_000, 500_000), 10.5)

    def test_unpriced_model_in_prices_json_is_none(self):
        env = {"PRICES_JSON": '{"m1": {"inPerMTok": 3, "outPerMTok": 15}}'}
        self.assertIsNone(cost_usd(env, "other", 10, 10))

    def test_falls_back_to_legacy_variables(self):
        env = {"PRICE_IN_PER_MTOK": "3", "PRICE_OUT_PER_MTOK": "15"}
        self.assertEqual(cost_usd(env, "m1", 1_000_000, 500_000), 10.5)

    def test_prices_json_wins_over_legacy_variables(self):
        env = {"PRICES_JSON": '{"m1": {"inPerMTok": 1, "outPerMTok": 1}}', "PRICE_IN_PER_MTOK": "9", "PRICE_OUT_PER_MTOK": "9"}
        self.assertEqual(cost_usd(env, "m1", 1_000_000, 1_000_000), 2.0)

    def test_no_prices_at_all_is_none(self):
        self.assertIsNone(cost_usd({}, "m1", 10, 10))

    def test_zero_tokens_with_a_price_is_zero(self):
        self.assertEqual(cost_usd({"PRICES_JSON": '{"m1": {"inPerMTok": 3, "outPerMTok": 15}}'}, "m1", 0, 0), 0.0)

    def test_malformed_prices_json_raises_naming_the_variable(self):
        with self.assertRaisesRegex(ValueError, "PRICES_JSON"):
            cost_usd({"PRICES_JSON": "{nope"}, "m1", 1, 1)

    def test_invalid_entry_raises_naming_the_variable(self):
        with self.assertRaisesRegex(ValueError, "PRICES_JSON"):
            cost_usd({"PRICES_JSON": '{"m1": {"inPerMTok": -1, "outPerMTok": 2}}'}, "m1", 1, 1)


if __name__ == "__main__":
    unittest.main()
