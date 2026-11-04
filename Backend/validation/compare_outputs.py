"""Compare the two extraction outputs and write a list of flags for the clinician UI.

Deterministic code only: no model call, no network, no judgement about clinical correctness.
It reads the output of Backend/extraction (model 1) and Backend/cross-check (model 2) and reports
where they differ. The same two inputs always give the same flags, in the same order.

Items are matched by the block they cite (block_id), never by the ids the models chose,
because two models name their nodes differently.

Usage:
  python3 compare_outputs.py
  python3 compare_outputs.py --extraction A.json --crosscheck B.json \
      --extraction-input A_blocks.json --crosscheck-input B_blocks.json --out flags.json

Defaults read ../extraction and ../cross-check (extraction_output.json, input_blocks.json)
and write flags.json in this folder.
"""
import argparse
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

here = Path(__file__).parent
SIDES = ("extraction", "crosscheck")
LISTS = ["nodes", "edges", "variables", "danger_signs", "thresholds", "actions", "followups", "unclear_items"]
SEV_ORDER = {"high": 0, "medium": 1, "low": 2}
NODE_CRITICAL_KINDS = {"decision", "outcome", "action", "followup"}

# Fields compared on a matched pair, with the severity of a difference.
# Model-chosen names (ids, variable names, labels) are deliberately not compared.
FIELDS = {
    "node": {"kind": "medium", "text": "medium", "clinical": "medium", "out_of_scope": "medium", "pdf_page": "low"},
    "threshold": {"op": "high", "value": "high", "unit": "high", "age_band": "high"},
    "danger_sign": {"text": "medium", "cough_relevant": "high", "condition_text": "medium"},
    "action": {"drug": "high", "dose_text": "high", "age_band": "high", "frequency": "high",
               "duration": "high", "type": "low"},
    "followup": {"text": "medium", "due_text": "high"},
    "variable": {"unit": "medium", "range_hint": "medium"},
    "edge": {"branch_label": "medium", "condition_text": "medium"},
}
# Fields that decide which of several candidates a block-sharing item pairs with, and their weight.
SCORE = {
    "node": {"text": 3, "kind": 1, "pdf_page": 1},
    "threshold": {"value": 2, "op": 1, "age_band": 1, "unit": 1},
    "danger_sign": {"text": 3},
    "action": {"drug": 2, "dose_text": 2, "age_band": 1, "type": 1},
    "followup": {"text": 3, "due_text": 1},
    "variable": {"unit": 1, "range_hint": 1},
}
LIST_OF = {"node": "nodes", "threshold": "thresholds", "danger_sign": "danger_signs", "action": "actions",
           "followup": "followups", "variable": "variables", "edge": "edges"}


def norm(v):
    """Comparison form of a value: numbers as floats, text with spaces and case folded."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return " ".join(unicodedata.normalize("NFKC", v).split()).casefold()
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def anchors(item):
    return {s["block_id"] for s in item.get("src", []) if isinstance(s, dict) and "block_id" in s}


def page_of(block_id):
    """Block ids look like p7.b17; the number after p is the pdf page."""
    head = str(block_id).split(".")[0]
    return int(head[1:]) if head[:1] == "p" and head[1:].isdigit() else None


def unclear_source(item, side):
    return [{"model": side, "block_id": item.get("block_id"), "pdf_page": page_of(item.get("block_id")),
             "quote": item.get("quote")}]


def short(item, limit=80):
    if "op" in item and "value" in item and "variable" in item:  # a threshold has no text of its own
        band = f", {item['age_band']}" if item.get("age_band") else ""
        return f"{item['variable']} {item['op']} {item['value']} {item.get('unit') or ''}{band}".replace("  ", " ")
    text = item.get("text") or item.get("label") or item.get("drug") or item.get("id") or "item"
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "..."


def pair_items(a_items, b_items, kind):
    """Greedy, deterministic pairing of items that cite a common block, best field agreement first."""
    weights = SCORE.get(kind, {})
    cands = []
    for i, a in enumerate(a_items):
        aa = anchors(a)
        for j, b in enumerate(b_items):
            if aa & anchors(b):
                score = sum(w for f, w in weights.items() if norm(a.get(f)) == norm(b.get(f)))
                cands.append((-score, i, j))
    cands.sort()
    used_a, used_b, pairs = set(), set(), []
    for _, i, j in cands:
        if i not in used_a and j not in used_b:
            used_a.add(i)
            used_b.add(j)
            pairs.append((i, j))
    pairs.sort()
    return (pairs,
            [i for i in range(len(a_items)) if i not in used_a],
            [j for j in range(len(b_items)) if j not in used_b])


def sources(item, side):
    out = []
    for s in item.get("src", []) if item else []:
        if isinstance(s, dict):
            out.append({"model": side, "block_id": s.get("block_id"), "pdf_page": s.get("pdf_page"),
                        "quote": s.get("quote")})
    return out


class Flags:
    def __init__(self):
        self.items = []

    def add(self, severity, ftype, category, summary, page=None, fields=None, a=None, b=None, extra_sources=None):
        srcs = sources(a, "extraction") + sources(b, "crosscheck") + (extra_sources or [])
        seen, uniq = set(), []
        for s in srcs:
            key = (s["model"], s["block_id"], s["quote"])
            if key not in seen:
                seen.add(key)
                uniq.append(s)
        if page is None:
            page = next((s["pdf_page"] for s in uniq if s["pdf_page"] is not None), None)
        self.items.append({"severity": severity, "type": ftype, "category": category, "pdf_page": page,
                           "summary": summary, "fields": fields or [], "extraction": a, "crosscheck": b,
                           "sources": uniq})

    def finish(self):
        self.items.sort(key=lambda f: (SEV_ORDER[f["severity"]], f["category"], f["pdf_page"] or 0,
                                       f["type"], f["summary"]))
        return [dict(id=f"F{n:03d}", status="open", **f) for n, f in enumerate(self.items, 1)]


def check_structure(side, out, flags):
    """Return the lists as {name: [dict items]}, flagging anything unusable."""
    clean = {}
    for name in LISTS:
        v = out.get(name)
        if not isinstance(v, list):
            flags.add("high", "invalid_output", name, f"The {side} output has no valid list '{name}'; it is compared as empty.")
            clean[name] = []
            continue
        dicts = [x for x in v if isinstance(x, dict)]
        if len(dicts) != len(v):
            flags.add("high", "invalid_output", name,
                      f"The {side} output has {len(v) - len(dicts)} entries in '{name}' that are not objects; they are ignored.")
        clean[name] = dicts
    return clean


def check_quotes(side, lists, blocks, flags):
    """Every cited quote must appear verbatim in the block it cites (recomputed here, not trusted)."""
    for name in LISTS:
        for item in lists[name]:
            cites = [(s.get("block_id"), s.get("quote"), s.get("pdf_page")) for s in item.get("src", []) if isinstance(s, dict)]
            if name == "unclear_items":
                cites.append((item.get("block_id"), item.get("quote"), None))
            if name != "unclear_items" and not cites:
                flags.add("high", "invalid_quote", name, f"The {side} output cites no source for {name[:-1]} '{short(item)}'.",
                          **{"a" if side == "extraction" else "b": item})
            for block_id, quote, page in cites:
                text = blocks.get(str(block_id))
                if text is None:
                    why = f"cites block {block_id}, which does not exist"
                elif not isinstance(quote, str) or quote.strip() == "" or quote not in text:
                    why = f"quotes text that is not in block {block_id}"
                else:
                    continue
                shown = quote if isinstance(quote, str) and len(quote) <= 120 else str(quote)[:120]
                flags.add("high", "invalid_quote", name, f"The {side} output {why}: '{shown}' ({name[:-1]} '{short(item)}').",
                          page=page, extra_sources=[{"model": side, "block_id": block_id, "pdf_page": page, "quote": shown}],
                          **{"a" if side == "extraction" else "b": item})


def compare_fields(kind, a, b, flags, label):
    diffs, sev = [], "low"
    for field, fsev in FIELDS[kind].items():
        if norm(a.get(field)) != norm(b.get(field)):
            diffs.append({"field": field, "extraction": a.get(field), "crosscheck": b.get(field)})
            if SEV_ORDER[fsev] < SEV_ORDER[sev]:
                sev = fsev
    if diffs:
        names = ", ".join(d["field"] for d in diffs)
        flags.add(sev, "value_mismatch", kind, f"{label}: the models differ on {names}.", fields=diffs, a=a, b=b)


def compare(a_out, b_out, a_blocks, b_blocks, same_input):
    flags = Flags()
    if not same_input:
        flags.add("high", "input_mismatch", "input",
                  "The two models were not given the same input (input_blocks.json differs); other flags may be caused by that.")
    A = check_structure("extraction", a_out, flags)
    B = check_structure("crosscheck", b_out, flags)
    check_quotes("extraction", A, a_blocks, flags)
    check_quotes("crosscheck", B, b_blocks, flags)

    matched = {}
    # Nodes first: their pairing translates ids so edges and trigger references can be compared.
    pairs, only_a, only_b = pair_items(A["nodes"], B["nodes"], "node")
    map_b2a = {B["nodes"][j].get("id"): A["nodes"][i].get("id") for i, j in pairs}
    a_by_id = {n.get("id"): n for n in A["nodes"]}
    b_by_id = {n.get("id"): n for n in B["nodes"]}
    matched["nodes"] = len(pairs)

    def node_label(side_by_id, ref):
        n = side_by_id.get(ref)
        return "none" if ref is None else (f"'{short(n)}'" if n else f"unknown node {ref}")

    def ref_equal(a_ref, b_ref):
        return a_ref is None and b_ref is None or (a_ref is not None and b_ref is not None and map_b2a.get(b_ref) == a_ref)

    def ref_diff(field, a, b, sev, flags_, kind, label):
        if not ref_equal(a.get(field), b.get(field)):
            flags_.add(sev, "value_mismatch", kind,
                       f"{label}: the models differ on {field} (extraction: {node_label(a_by_id, a.get(field))}, "
                       f"crosscheck: {node_label(b_by_id, b.get(field))}).",
                       fields=[{"field": field, "extraction": node_label(a_by_id, a.get(field)),
                                "crosscheck": node_label(b_by_id, b.get(field))}], a=a, b=b)

    for i, j in pairs:
        a, b = A["nodes"][i], B["nodes"][j]
        label = f"Node '{short(a)}'"
        compare_fields("node", a, b, flags, label)
        ref_diff("parent_id", a, b, "medium", flags, "node", label)
        ref_diff("goto_target", a, b, "medium", flags, "node", label)
    for idx, side, other in ((only_a, "extraction", "crosscheck"), (only_b, "crosscheck", "extraction")):
        for k in idx:
            n = (A if side == "extraction" else B)["nodes"][k]
            sev = "high" if n.get("clinical") is True or n.get("kind") in NODE_CRITICAL_KINDS else "medium"
            flags.add(sev, f"missing_in_{other}", "node", f"Node '{short(n)}' ({n.get('kind')}) is in the {side} output but not the {other} output.",
                      **{"a" if side == "extraction" else "b": n})

    # Edges: compared through the node pairing.
    def edge_key_a(e):
        return (e.get("from"), e.get("to"))

    def edge_key_b(e):
        return (map_b2a.get(e.get("from")), map_b2a.get(e.get("to")))

    b_edges = {}
    for e in B["edges"]:
        k = edge_key_b(e)
        if None not in k:
            b_edges.setdefault(k, []).append(e)
    used = set()
    edge_pairs = 0
    for e in A["edges"]:
        k = edge_key_a(e)
        pool = b_edges.get(k, [])
        take = next((x for x in pool if id(x) not in used), None)
        label = f"Edge '{short(a_by_id.get(e.get('from'), {}))}' -> '{short(a_by_id.get(e.get('to'), {}))}'"
        if take is None:
            flags.add("high", "missing_in_crosscheck", "edge", f"{label} is in the extraction output but not the crosscheck output.", a=e)
            continue
        used.add(id(take))
        edge_pairs += 1
        compare_fields("edge", e, take, flags, label)
        da, db = e.get("draft_condition"), take.get("draft_condition")
        sub = lambda d: {f: norm(d.get(f)) for f in ("op", "value", "unit", "age_band")} if isinstance(d, dict) else None
        if sub(da) != sub(db):
            flags.add("high", "value_mismatch", "edge", f"{label}: the models differ on draft_condition.",
                      fields=[{"field": "draft_condition", "extraction": da, "crosscheck": db}], a=e, b=take)
    for e in B["edges"]:
        if id(e) not in used:
            fr, to = b_by_id.get(e.get("from"), {}), b_by_id.get(e.get("to"), {})
            flags.add("high", "missing_in_extraction", "edge",
                      f"Edge '{short(fr)}' -> '{short(to)}' is in the crosscheck output but not the extraction output.", b=e)
    matched["edges"] = edge_pairs

    for kind in ("threshold", "danger_sign", "action", "followup", "variable"):
        name = LIST_OF[kind]
        pairs, only_a, only_b = pair_items(A[name], B[name], kind)
        matched[name] = len(pairs)
        high_missing = kind != "variable"
        for i, j in pairs:
            a, b = A[name][i], B[name][j]
            label = f"{kind.replace('_', ' ').capitalize()} '{short(a)}'"
            compare_fields(kind, a, b, flags, label)
            if kind in ("action", "followup"):
                ref_diff("trigger_node_id", a, b, "high", flags, kind, label)
        for idx, side, other in ((only_a, "extraction", "crosscheck"), (only_b, "crosscheck", "extraction")):
            for k in idx:
                it = (A if side == "extraction" else B)[name][k]
                flags.add("high" if high_missing else "low", f"missing_in_{other}", kind,
                          f"{kind.replace('_', ' ').capitalize()} '{short(it)}' is in the {side} output but not the {other} output.",
                          **{"a" if side == "extraction" else "b": it})

    # Unclear items: a person must see every one (ambiguity is never settled silently).
    a_u, b_u = A["unclear_items"], B["unclear_items"]
    used_b = set()
    for a in a_u:
        j = next((j for j, b in enumerate(b_u) if j not in used_b and b.get("block_id") == a.get("block_id")), None)
        if j is None:
            flags.add("medium", "unclear_item", "unclear_item",
                      f"Only the extraction model found this unclear: {a.get('what_is_unclear')}", a=a,
                      extra_sources=unclear_source(a, "extraction"))
        else:
            used_b.add(j)
            flags.add("high", "unclear_item", "unclear_item",
                      f"Both models found this unclear: {a.get('what_is_unclear')}", a=a, b=b_u[j],
                      extra_sources=unclear_source(a, "extraction") + unclear_source(b_u[j], "crosscheck"))
    matched["unclear_items"] = len(used_b)
    for j, b in enumerate(b_u):
        if j not in used_b:
            flags.add("medium", "unclear_item", "unclear_item",
                      f"Only the crosscheck model found this unclear: {b.get('what_is_unclear')}", b=b,
                      extra_sources=unclear_source(b, "crosscheck"))

    counts = {n: {"extraction": len(A[n]), "crosscheck": len(B[n]), "matched": matched.get(n, 0)} for n in LISTS}
    return flags.finish(), counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extraction", default=str(here.parent / "extraction" / "extraction_output.json"))
    ap.add_argument("--crosscheck", default=str(here.parent / "cross-check" / "extraction_output.json"))
    ap.add_argument("--extraction-input", default=str(here.parent / "extraction" / "input_blocks.json"))
    ap.add_argument("--crosscheck-input", default=str(here.parent / "cross-check" / "input_blocks.json"))
    ap.add_argument("--out", default=str(here / "flags.json"))
    args = ap.parse_args()

    paths = {"extraction_output": args.extraction, "crosscheck_output": args.crosscheck,
             "extraction_input": args.extraction_input, "crosscheck_input": args.crosscheck_input}
    data = {k: json.loads(Path(p).read_text()) for k, p in paths.items()}
    blocks = {}
    for side in SIDES:
        blocks[side] = {b["block_id"]: b["text"] for p in data[side + "_input"]["pages"] for b in p["blocks"]}

    hashes = {k: sha256_file(p) for k, p in paths.items()}
    same_input = (hashes["extraction_input"] == hashes["crosscheck_input"]
                  and data["extraction_input"].get("doc_sha256") == data["crosscheck_input"].get("doc_sha256"))
    flags, counts = compare(data["extraction_output"], data["crosscheck_output"], blocks["extraction"],
                            blocks["crosscheck"], same_input)

    models = {s: (data[s + "_output"].get("_run") or {}).get("model_id", "not recorded in the output file") for s in SIDES}
    by_sev = {s: sum(1 for f in flags if f["severity"] == s) for s in SEV_ORDER}
    by_type = {}
    for f in flags:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1
    result = {
        "models": models,
        "files": {k: {"path": paths[k], "sha256": hashes[k]} for k in paths},
        "summary": {"flag_count": len(flags), "by_severity": by_sev, "by_type": by_type, "items": counts},
        "notice": "No flags means the two models agree. It does not mean the extraction is correct; a person still reviews it.",
        "flags": flags,
    }
    Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))

    print(f"models: extraction={models['extraction']}  crosscheck={models['crosscheck']}")
    print(f"flags: {len(flags)}  (high {by_sev['high']}, medium {by_sev['medium']}, low {by_sev['low']})")
    for name in LISTS:
        c = counts[name]
        print(f"  {name:13s} extraction {c['extraction']:3d}  crosscheck {c['crosscheck']:3d}  matched {c['matched']:3d}")
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
