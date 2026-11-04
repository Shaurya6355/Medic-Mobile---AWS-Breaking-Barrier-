"""Cost of one model call, from the same PRICES_JSON the server reads (DEC-003).

PRICES_JSON is a JSON map of model id to {"inPerMTok": number, "outPerMTok": number} (USD per million
tokens). When it is unset, the older PRICE_IN_PER_MTOK / PRICE_OUT_PER_MTOK variables still work and
apply to any model. Returns None when no price applies, so a missing price is never shown as $0.
"""
import json
import math


def _price(entry):
    try:
        pin, pout = float(entry["inPerMTok"]), float(entry["outPerMTok"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("PRICES_JSON is invalid: each entry needs numeric inPerMTok and outPerMTok")
    if not (math.isfinite(pin) and math.isfinite(pout)) or pin < 0 or pout < 0:
        raise ValueError("PRICES_JSON is invalid: prices must be finite and not negative")
    return pin, pout


def cost_usd(env, model_id, input_tokens, output_tokens):
    raw = (env.get("PRICES_JSON") or "").strip()
    if raw:
        try:
            table = json.loads(raw)
        except ValueError:
            raise ValueError("PRICES_JSON is not valid JSON")
        if not isinstance(table, dict):
            raise ValueError("PRICES_JSON is invalid: expected a JSON object keyed by model id")
        if model_id not in table:
            return None
        pin, pout = _price(table[model_id])
    else:
        legacy_in, legacy_out = env.get("PRICE_IN_PER_MTOK"), env.get("PRICE_OUT_PER_MTOK")
        if not legacy_in and not legacy_out:
            return None
        pin, pout = float(legacy_in or 0), float(legacy_out or 0)
    return (input_tokens * pin + output_tokens * pout) / 1_000_000
