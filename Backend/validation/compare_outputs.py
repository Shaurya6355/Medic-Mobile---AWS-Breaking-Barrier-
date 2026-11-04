"""Compare the two extraction outputs and write a list of flags for the clinician UI.

Deterministic code only: no model call, no network, no judgement about clinical correctness.
It reads the output of Backend/extraction (model 1) and Backend/cross-check (model 2) and reports
where they differ. The same two inputs always give the same flags, in the same order.

How items are paired: first by the block they cite (block_id); items left over are then paired by
matching text (the same sentence can appear on two pages, so two models may cite different blocks).
Model-chosen ids are never compared.

How differences are graded: a value that differs keeps the field's severity (for example a threshold
number is high). A difference that is only wording (units written another way, "in 3 days" against
"3 days", a leading "Age") is kept as a low flag and never dropped. Missing nodes and edges are
grouped into one flag per page and side. Edges whose two ends sit in different cross-check batches
are reported as expected gaps (low).

Usage:
  python3 compare_outputs.py
  python3 compare_outputs.py --extraction A.json --crosscheck B.json \
      --extraction-input A_blocks.json --crosscheck-input B_blocks.json --out flags.json

Defaults read ../extraction and ../cross-check (extraction_output.json, input_blocks.json)
and write flags.json in this folder.
"""
import argparse
import difflib
import hashlib
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

here = Path(__file__).parent
SIDES = ("extraction", "crosscheck")
LISTS = ["nodes", "edges", "variables", "danger_signs", "thresholds", "actions", "followups", "unclear_items"]
SEV_ORDER = {"high": 0, "medium": 1, "low": 2}
NODE_CRITICAL_KINDS = {"decision", "outcome", "action", "followup"}

# field -> (severity of a real difference, comparison mode)
#   strict: must be equal after trimming and case folding
#   loose:  also equal if only wording differs (units, prefixes, one contains the other)
#   tight:  also equal if the text is almost identical (similarity 0.9 or more), no containment
# Model-chosen names (ids, variable names, labels) are deliberately not compared.
FIELDS = {
    "node": {"kind": ("medium", "strict"), "text": ("medium", "loose"), "clinical": ("medium", "strict"),
             "out_of_scope": ("medium", "strict"), "pdf_page": ("low", "strict")},
    "threshold": {"op": ("high", "strict"), "value": ("high", "strict"), "unit": ("high", "loose"),
                  "age_band": ("high", "loose")},
    "danger_sign": {"text": ("medium", "loose"), "cough_relevant": ("high", "strict"),
                    "condition_text": ("medium", "loose")},
    "action": {"drug": ("high", "loose"), "dose_text": ("high", "tight"), "age_band": ("high", "loose"),
               "frequency": ("high", "loose"), "duration": ("high", "loose"), "type": ("low", "loose")},
    "followup": {"text": ("medium", "loose"), "due_text": ("high", "loose")},
    "variable": {"unit": ("medium", "loose"), "range_hint": ("medium", "loose")},
    "edge": {"branch_label": ("medium", "loose"), "condition_text": ("medium", "loose")},
}
# Fields that decide which of several candidates sharing a block an item pairs with, and their weight.
SCORE = {
    "node": {"text": 3, "kind": 1, "pdf_page": 1},
    "threshold": {"value": 2, "op": 1, "age_band": 1, "unit": 1},
    "danger_sign": {"text": 3},
    "action": {"drug": 2, "dose_text": 2, "age_band": 1, "type": 1},
    "followup": {"text": 3, "due_text": 1},
    "variable": {"unit": 1, "range_hint": 1},
}
# Minimum text similarity for pairing leftover items that share no block.
TEXT_PAIR_MIN = {"node": 0.8, "danger_sign": 0.85, "followup": 0.8, "action": 0.7, "threshold": 1.0}
LIST_OF = {"node": "nodes", "threshold": "thresholds", "danger_sign": "danger_signs", "action": "actions",
           "followup": "followups", "variable": "variables", "edge": "edges"}

UNIT_SYNONYMS = [
    (re.compile(r"breaths? ?(per|/) ?min(ute)?s?"), "breaths/min"),
    (re.compile(r"\bbpm\b"), "breaths/min"),
    (re.compile(r"amoxycillin"), "amoxicillin"),
]
FILLER = re.compile(r"\b(age|aged|in|the|a|of)\b")


def norm(v):
    """Comparison form of a value: numbers as floats, text with spaces and case folded."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return " ".join(unicodedata.normalize("NFKC", v).split()).casefold()
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def loose_norm(v):
    """Wording-insensitive form of a string: units unified, punctuation and filler words removed."""
    s = norm(v)
    if not isinstance(s, str):
        return s
    for pat, rep in UNIT_SYNONYMS:
        s = pat.sub(rep, s)
    s = re.sub(r"[^\w/ ]+", " ", s)
    s = FILLER.sub(" ", s)
    return " ".join(s.split())


def similar(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


def contained(a, b, min_len=4):
    return min(len(a), len(b)) >= min_len and (a in b or b in a)


def judge(a, b, mode):
    """'same', 'wording' (only the wording differs) or 'different'."""
    na, nb = norm(a), norm(b)
    if na == nb:
        return "same"
    if mode == "strict" or na is None or nb is None or not (isinstance(a, str) and isinstance(b, str)):
        return "different"
    la, lb = loose_norm(a), loose_norm(b)
    if la == lb or similar(la, lb) >= 0.9:
        return "wording"
    if mode == "loose" and contained(la, lb):
        return "wording"
    return "different"


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


def listed(labels, limit=6):
    shown = "; ".join(f"'{x}'" for x in labels[:limit])
    return shown + (f"; and {len(labels) - limit} more" if len(labels) > limit else "")


def text_similarity(a, b, kind):
    """Similarity used only to pair leftover items that cite no common block."""
    if kind == "threshold":
        same = (norm(a.get("value")) == norm(b.get("value"))
                and judge(a.get("age_band"), b.get("age_band"), "loose") != "different"
                and judge(a.get("unit"), b.get("unit"), "loose") != "different"
                and norm(a.get("op")) == norm(b.get("op")))
        return 1.0 if same else 0.0
    if kind == "action":
        da, db = loose_norm(a.get("drug") or ""), loose_norm(b.get("drug") or "")
        if not da or not db:
            return 0.0
        return 1.0 if contained(da, db) else similar(da, db)
    la, lb = loose_norm(a.get("text") or ""), loose_norm(b.get("text") or "")
    return similar(la, lb) if la and lb else 0.0


def pair_items(a_items, b_items, kind):
    """Deterministic pairing. Pass 1: items sharing a cited block, best field agreement first.
    Pass 2: leftover items with matching text. Returns (pairs, only_a, only_b, text_pairs)."""
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
    text_pairs = 0
    if kind in TEXT_PAIR_MIN:
        extra = []
        for i, a in enumerate(a_items):
            if i in used_a:
                continue
            for j, b in enumerate(b_items):
                if j in used_b:
                    continue
                s = text_similarity(a, b, kind)
                if s >= TEXT_PAIR_MIN[kind]:
                    extra.append((-s, i, j))
        extra.sort()
        for _, i, j in extra:
            if i not in used_a and j not in used_b:
                used_a.add(i)
                used_b.add(j)
                pairs.append((i, j))
                text_pairs += 1
    pairs.sort()
    return (pairs,
            [i for i in range(len(a_items)) if i not in used_a],
            [j for j in range(len(b_items)) if j not in used_b],
            text_pairs)


def repeats_paired(item, items, paired_idx, min_sim=0.9):
    """True when this unpaired item says the same thing as an item on its own side that did pair
    (a model listing the same sentence twice, for example from two pages)."""
    text = loose_norm(item.get("text") or "")
    if not text:
        return False
    return any(i in paired_idx and item is not other and similar(text, loose_norm(other.get("text") or "")) >= min_sim
               for i, other in enumerate(items))


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

    def add(self, severity, ftype, category, summary, page=None, fields=None, a=None, b=None,
            extra_sources=None, items=None):
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
                           "summary": summary, "fields": fields or [], "items": items or [],
                           "extraction": a, "crosscheck": b, "sources": uniq})

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


def describe(name, item, nodes_by_id):
    if name == "edges":
        fr, to = nodes_by_id.get(item.get("from"), {}), nodes_by_id.get(item.get("to"), {})
        return f"{short(fr)} -> {short(to)}"
    return short(item)


def check_quotes(side, lists, blocks, flags):
    """Every cited quote must appear verbatim in the block it cites (recomputed here, not trusted).
    Items that cite nothing are reported as one flag per list."""
    nodes_by_id = {n.get("id"): n for n in lists["nodes"]}
    key = "a" if side == "extraction" else "b"
    for name in LISTS:
        uncited = []
        for item in lists[name]:
            cites = [(s.get("block_id"), s.get("quote"), s.get("pdf_page")) for s in item.get("src", []) if isinstance(s, dict)]
            if name == "unclear_items":
                cites.append((item.get("block_id"), item.get("quote"), None))
            elif not cites:
                uncited.append(item)
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
                          **{key: item})
        if uncited:
            labels = [describe(name, it, nodes_by_id) for it in uncited]
            flags.add("high", "invalid_quote", name,
                      f"The {side} output has {len(uncited)} {name} that cite no source: {listed(labels)}.",
                      items=[{"label": l, "severity": "high", "sources": []} for l in labels])


def compare_fields(kind, a, b, flags, label):
    real, wording = [], []
    for field, (fsev, mode) in FIELDS[kind].items():
        verdict = judge(a.get(field), b.get(field), mode)
        if verdict == "same":
            continue
        entry = {"field": field, "extraction": a.get(field), "crosscheck": b.get(field), "level": verdict}
        (real if verdict == "different" else wording).append((fsev, entry))
    if real:
        sev = min((s for s, _ in real), key=lambda s: SEV_ORDER[s])
        names = ", ".join(e["field"] for _, e in real)
        flags.add(sev, "value_mismatch", kind, f"{label}: the models differ on {names}.",
                  fields=[e for _, e in real + wording], a=a, b=b)
    elif wording:
        names = ", ".join(e["field"] for _, e in wording)
        flags.add("low", "value_mismatch", kind, f"{label}: only the wording differs on {names}.",
                  fields=[e for _, e in wording], a=a, b=b)


def compare(a_out, b_out, a_blocks, b_blocks, same_input, cross_batch_size=None):
    flags = Flags()
    if not same_input:
        flags.add("high", "input_mismatch", "input",
                  "The two models were not given the same input (input_blocks.json differs); other flags may be caused by that.")
    A = check_structure("extraction", a_out, flags)
    B = check_structure("crosscheck", b_out, flags)
    check_quotes("extraction", A, a_blocks, flags)
    check_quotes("crosscheck", B, b_blocks, flags)

    matched, by_text = {}, {}
    groups = {}  # (type, category, page, expected_gap) -> [{"label", "severity", "item"}]

    def group(ftype, cat, page, sev, label, item, expected_gap=False):
        groups.setdefault((ftype, cat, page, expected_gap), []).append({"label": label, "severity": sev, "item": item})

    # Nodes first: their pairing translates ids so edges and trigger references can be compared.
    pairs, only_a, only_b, tp = pair_items(A["nodes"], B["nodes"], "node")
    map_b2a = {B["nodes"][j].get("id"): A["nodes"][i].get("id") for i, j in pairs}
    a_by_id = {n.get("id"): n for n in A["nodes"]}
    b_by_id = {n.get("id"): n for n in B["nodes"]}
    matched["nodes"], by_text["nodes"] = len(pairs), tp

    def node_label(by_id, ref):
        n = by_id.get(ref)
        return "none" if ref is None else (f"'{short(n)}'" if n else f"unknown node {ref}")

    def ref_equal(a_ref, b_ref):
        return (a_ref is None and b_ref is None) or (a_ref is not None and b_ref is not None and map_b2a.get(b_ref) == a_ref)

    def ref_diff(field, a, b, sev, kind, label):
        if not ref_equal(a.get(field), b.get(field)):
            flags.add(sev, "value_mismatch", kind,
                      f"{label}: the models differ on {field} (extraction: {node_label(a_by_id, a.get(field))}, "
                      f"crosscheck: {node_label(b_by_id, b.get(field))}).",
                      fields=[{"field": field, "extraction": node_label(a_by_id, a.get(field)),
                               "crosscheck": node_label(b_by_id, b.get(field)), "level": "different"}], a=a, b=b)

    for i, j in pairs:
        a, b = A["nodes"][i], B["nodes"][j]
        label = f"Node '{short(a)}'"
        compare_fields("node", a, b, flags, label)
        ref_diff("parent_id", a, b, "medium", "node", label)
        ref_diff("goto_target", a, b, "medium", "node", label)
    paired_a, paired_b = {i for i, _ in pairs}, {j for _, j in pairs}
    for idx, side, other, lists, paired in ((only_a, "extraction", "crosscheck", A, paired_a),
                                            (only_b, "crosscheck", "extraction", B, paired_b)):
        for k in idx:
            n = lists["nodes"][k]
            if repeats_paired(n, lists["nodes"], paired):
                group(f"missing_in_{other}", "node", n.get("pdf_page"), "low", f"{short(n)} ({n.get('kind')}, repeats a node already compared)", n)
                continue
            sev = "high" if n.get("clinical") is True or n.get("kind") in NODE_CRITICAL_KINDS else "medium"
            group(f"missing_in_{other}", "node", n.get("pdf_page"), sev, f"{short(n)} ({n.get('kind')})", n)

    # Edges: compared through the node pairing.
    def batch_of(page):
        return (page - 1) // cross_batch_size if cross_batch_size and isinstance(page, int) else None

    b_edges = {}
    for e in B["edges"]:
        k = (map_b2a.get(e.get("from")), map_b2a.get(e.get("to")))
        if None not in k:
            b_edges.setdefault(k, []).append(e)
    used, edge_pairs = set(), 0
    for e in A["edges"]:
        k = (e.get("from"), e.get("to"))
        take = next((x for x in b_edges.get(k, []) if id(x) not in used), None)
        fr, to = a_by_id.get(e.get("from"), {}), a_by_id.get(e.get("to"), {})
        label = f"Edge '{short(fr)}' -> '{short(to)}'"
        if take is None:
            gap = batch_of(fr.get("pdf_page")) is not None and batch_of(fr.get("pdf_page")) != batch_of(to.get("pdf_page"))
            group("missing_in_crosscheck", "edge", fr.get("pdf_page"), "low" if gap else "high",
                  f"{short(fr)} -> {short(to)}", e, expected_gap=gap)
            continue
        used.add(id(take))
        edge_pairs += 1
        compare_fields("edge", e, take, flags, label)
        da, db = e.get("draft_condition"), take.get("draft_condition")
        sub = lambda d: {f: norm(d.get(f)) for f in ("op", "value", "unit", "age_band")} if isinstance(d, dict) else None
        if sub(da) != sub(db):
            flags.add("high", "value_mismatch", "edge", f"{label}: the models differ on draft_condition.",
                      fields=[{"field": "draft_condition", "extraction": da, "crosscheck": db, "level": "different"}],
                      a=e, b=take)
    for e in B["edges"]:
        if id(e) not in used:
            fr, to = b_by_id.get(e.get("from"), {}), b_by_id.get(e.get("to"), {})
            group("missing_in_extraction", "edge", fr.get("pdf_page"), "high", f"{short(fr)} -> {short(to)}", e)
    matched["edges"], by_text["edges"] = edge_pairs, 0

    for kind in ("threshold", "danger_sign", "action", "followup", "variable"):
        name = LIST_OF[kind]
        pairs, only_a, only_b, tp = pair_items(A[name], B[name], kind)
        matched[name], by_text[name] = len(pairs), tp
        for i, j in pairs:
            a, b = A[name][i], B[name][j]
            label = f"{kind.replace('_', ' ').capitalize()} '{short(a)}'"
            compare_fields(kind, a, b, flags, label)
            if kind in ("action", "followup"):
                ref_diff("trigger_node_id", a, b, "high", kind, label)
        paired_a, paired_b = {i for i, _ in pairs}, {j for _, j in pairs}
        for idx, side, other, lists, paired in ((only_a, "extraction", "crosscheck", A, paired_a),
                                                (only_b, "crosscheck", "extraction", B, paired_b)):
            for k in idx:
                it = lists[name][k]
                what = kind.replace("_", " ").capitalize()
                if kind in ("danger_sign", "followup") and repeats_paired(it, lists[name], paired):
                    flags.add("low", f"missing_in_{other}", kind,
                              f"{what} '{short(it)}' appears again in the {side} output (it repeats one already compared) and has no match in the {other} output.",
                              **{"a" if side == "extraction" else "b": it})
                    continue
                flags.add("low" if kind == "variable" else "high", f"missing_in_{other}", kind,
                          f"{what} '{short(it)}' is in the {side} output but not the {other} output.",
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
    matched["unclear_items"], by_text["unclear_items"] = len(used_b), 0
    for j, b in enumerate(b_u):
        if j not in used_b:
            flags.add("medium", "unclear_item", "unclear_item",
                      f"Only the crosscheck model found this unclear: {b.get('what_is_unclear')}", b=b,
                      extra_sources=unclear_source(b, "crosscheck"))

    # One flag per (type, category, page): missing nodes and edges are structure, not separate findings.
    for (ftype, cat, page, gap), members in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2] or 0, kv[0][3])):
        present = "extraction" if ftype == "missing_in_crosscheck" else "crosscheck"
        absent = "crosscheck" if present == "extraction" else "extraction"
        n = len(members)
        sev = min((m["severity"] for m in members), key=lambda s: SEV_ORDER[s])
        where = f" on page {page}" if page is not None else ""
        tail = " The cross-check cannot produce these: their two ends are in different batches." if gap else ""
        flags.add(sev, ftype, cat,
                  f"{n} {cat}{'s' if n > 1 else ''}{where} {'is' if n == 1 else 'are'} in the {present} output but not the "
                  f"{absent} output: {listed([m['label'] for m in members])}.{tail}",
                  page=page,
                  items=[{"label": m["label"], "severity": m["severity"], "sources": sources(m["item"], present)} for m in members],
                  extra_sources=[s for m in members for s in sources(m["item"], present)])

    counts = {n: {"extraction": len(A[n]), "crosscheck": len(B[n]), "matched": matched.get(n, 0),
                  "matched_by_text": by_text.get(n, 0)} for n in LISTS}
    return flags.finish(), counts


def model_of(output, output_path):
    """Model id from the output's _run block, else from run_metrics.json next to it."""
    mid = (output.get("_run") or {}).get("model_id")
    if mid:
        return mid
    metrics = Path(output_path).parent / "run_metrics.json"
    if metrics.is_file():
        try:
            return json.loads(metrics.read_text()).get("model_id") or "not recorded"
        except (ValueError, OSError):
            pass
    return "not recorded"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extraction", default=str(here.parent / "extraction" / "extraction_output.json"))
    ap.add_argument("--crosscheck", default=str(here.parent / "cross-check" / "extraction_output.json"))
    ap.add_argument("--extraction-input", default=str(here.parent / "extraction" / "input_blocks.json"))
    ap.add_argument("--crosscheck-input", default=str(here.parent / "cross-check" / "input_blocks.json"))
    ap.add_argument("--crosscheck-batch-size", type=int, default=None,
                    help="pages per cross-check request; inferred from the output when it records its batches")
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
    batch_size = args.crosscheck_batch_size
    nb = (data["crosscheck_output"].get("_run") or {}).get("batches")
    if batch_size is None and isinstance(nb, int) and nb > 1:
        batch_size = math.ceil(data["crosscheck_input"]["page_count"] / nb)
    flags, counts = compare(data["extraction_output"], data["crosscheck_output"], blocks["extraction"],
                            blocks["crosscheck"], same_input, batch_size)

    models = {"extraction": model_of(data["extraction_output"], paths["extraction_output"]),
              "crosscheck": model_of(data["crosscheck_output"], paths["crosscheck_output"])}
    by_sev = {s: sum(1 for f in flags if f["severity"] == s) for s in SEV_ORDER}
    by_type = {}
    for f in flags:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1
    result = {
        "models": models,
        "files": {k: {"path": paths[k], "sha256": hashes[k]} for k in paths},
        "crosscheck_batch_size": batch_size,
        "summary": {"flag_count": len(flags), "by_severity": by_sev, "by_type": by_type, "items": counts},
        "notice": "No flags means the two models agree. It does not mean the extraction is correct; a person still reviews it.",
        "flags": flags,
    }
    Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))

    print(f"models: extraction={models['extraction']}  crosscheck={models['crosscheck']}")
    print(f"flags: {len(flags)}  (high {by_sev['high']}, medium {by_sev['medium']}, low {by_sev['low']})")
    for name in LISTS:
        c = counts[name]
        print(f"  {name:13s} extraction {c['extraction']:3d}  crosscheck {c['crosscheck']:3d}  matched {c['matched']:3d}  (by text {c['matched_by_text']})")
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
