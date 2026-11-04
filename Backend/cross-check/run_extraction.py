"""Cross-check: the same extraction task as Backend/extraction, run on a second model
(Llama 4 Scout 17B Instruct) on Amazon Bedrock. Saves outputs here.

Llama 4 Scout accepts at most 3 images and 8192 output tokens per request, so the pages are sent in
batches of 3 (default) and the batch results are merged here in code. The prompt (final_prompt.txt)
is unchanged; each request adds a short batch note (see batch_note).

Needs: AWS credentials, `pip install boto3`, env CROSSCHECK_MODEL_ID (a us. inference profile id).
Settings may also be put in Backend/.env (git-ignored).
Optional env: CROSSCHECK_MAX_TOKENS (default 8192, the model limit), CROSSCHECK_BATCH_SIZE (default 3),
AWS_REGION, PRICE_IN_PER_MTOK, PRICE_OUT_PER_MTOK (USD).
Writes: extraction_output.json, run_metrics.json, raw_response.txt in this folder.
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import boto3
from botocore.config import Config

LISTS = ["nodes", "edges", "variables", "danger_signs", "thresholds", "actions", "followups", "unclear_items"]
PREFIXED = ["nodes", "actions", "followups", "danger_signs", "unclear_items"]


def load_env(path):
    if path.is_file():
        for line in path.read_text().splitlines():
            k, _, v = line.strip().partition("=")
            if k and v and not k.startswith("#") and k not in os.environ:
                os.environ[k] = v.strip().strip('"').strip("'")


here = Path(__file__).parent
load_env(here.parent / ".env")
doc = json.loads((here / "input_blocks.json").read_text())
system = (here / "final_prompt.txt").read_text()
model_id = os.environ["CROSSCHECK_MODEL_ID"]
max_tokens = int(os.environ.get("CROSSCHECK_MAX_TOKENS", 8192))
batch_size = int(os.environ.get("CROSSCHECK_BATCH_SIZE", 3))
run_id = time.strftime("run-%Y%m%d-%H%M%S")
client = boto3.client("bedrock-runtime", config=Config(read_timeout=900, retries={"total_max_attempts": 1}),
                      region_name=os.environ.get("AWS_REGION", "us-west-2"))

pages = doc["pages"]
batches = [pages[i:i + batch_size] for i in range(0, len(pages), batch_size)]


def batch_note(k, group):
    a, b = group[0]["pdf_page"], group[-1]["pdf_page"]
    return (f"Batch {k} of {len(batches)}. This request contains only pdf_pages {a} to {b} of a "
            f"{doc['page_count']}-page document. Return the JSON object for these pages only.\n"
            f"Rules for this request, on top of the rules above:\n"
            f"1. Start every id you create for nodes, actions, followups, danger_signs and unclear_items with \"b{k}_\". "
            f"Variable ids get no prefix and are reused across pages as before.\n"
            f"2. For a go-to or see-page link whose target page is outside pages {a} to {b}, set goto_target to the text "
            f"\"page:<N>\", where N is the page number written in the link. Do not add an unclear item only because a "
            f"link points outside this request.\n"
            f"3. Edges and parent_id may only join nodes you create in this request.")


def run_batch(k):
    group = batches[k - 1]
    content = [{"text": f"Run: {run_id}\nSource: {doc['source_id']}   Pages: {doc['page_count']}\n"
                        f"Mode: new_guideline\n{batch_note(k, group)}\nFor each page, in order:"}]
    for p in group:
        content.append({"text": f"--- pdf_page {p['pdf_page']} ---"})
        content.append({"image": {"format": "png", "source": {"bytes": (here / p["image"]).read_bytes()}}})
        content.append({"text": "Blocks: " + json.dumps(p["blocks"], ensure_ascii=False)})
    content.append({"text": "Return one JSON object for these pages."})
    rec = {"batch": k, "pdf_pages": [p["pdf_page"] for p in group], "error": None, "out": None}
    t0 = time.time()
    try:
        resp = client.converse(modelId=model_id, system=[{"text": system}],
                               messages=[{"role": "user", "content": content}],
                               inferenceConfig={"maxTokens": max_tokens, "temperature": 0.1})
    except Exception as e:  # a failed batch is recorded; the other batches still run
        rec["latency_seconds"] = round(time.time() - t0, 2)
        rec["error"] = f"{type(e).__name__}: {str(e)[-200:]}"
        rec["text"] = ""
        return rec
    rec["latency_seconds"] = round(time.time() - t0, 2)
    rec["text"] = "".join(c.get("text", "") for c in resp["output"]["message"]["content"])
    rec["input_tokens"], rec["output_tokens"] = resp["usage"]["inputTokens"], resp["usage"]["outputTokens"]
    rec["stop_reason"] = resp["stopReason"]
    a, b = rec["text"].find("{"), rec["text"].rfind("}")
    rec["json_was_wrapped"] = rec["text"].strip() != rec["text"][a:b + 1] if a != -1 and b > a else None
    if resp["stopReason"] == "max_tokens":
        rec["error"] = "reply cut off at max tokens; JSON incomplete"
        return rec
    try:
        rec["out"] = json.loads(rec["text"][a:b + 1] if a != -1 and b > a else rec["text"])
    except json.JSONDecodeError as e:
        rec["error"] = f"reply is not valid JSON ({e})"
    return rec


with ThreadPoolExecutor(max_workers=len(batches)) as pool:
    results = list(pool.map(run_batch, range(1, len(batches) + 1)))

(here / "raw_response.txt").write_text("\n".join(
    f"===== batch {r['batch']} (pdf_pages {r['pdf_pages']}) =====\n{r['text']}\n" for r in results))

# ---- merge the batches (deterministic) ----
notes, merged = [], {k: [] for k in LISTS}
offset = 0
for r in results:
    out = r["out"]
    if not isinstance(out, dict):
        notes.append(f"batch {r['batch']} (pages {r['pdf_pages']}) has no usable output: {r['error']}")
        continue
    top = max([n.get("order", 0) for n in out.get("nodes", []) if isinstance(n.get("order"), int)] or [0])
    for name in LISTS:
        items = out.get(name)
        if not isinstance(items, list):
            notes.append(f"batch {r['batch']}: list '{name}' missing or not a list")
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            if name == "nodes" and isinstance(it.get("order"), int):
                it["order"] += offset  # keeps each batch's own ordering, after the earlier batches
            if name == "variables":
                same = next((v for v in merged["variables"] if v.get("id") == it.get("id")), None)
                if same:
                    same["used_by"] = sorted(set(same.get("used_by", [])) | set(it.get("used_by", [])))
                    same["src"] = same.get("src", []) + it.get("src", [])
                    continue
            merged[name].append(it)
    offset += top

for name in PREFIXED:
    ids = [i.get("id") for i in merged[name]]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        notes.append(f"duplicate ids in {name}: {dup}")

resolved = unresolved = 0
for n in merged["nodes"]:
    t = n.get("goto_target")
    if isinstance(t, str) and t.startswith("page:"):
        try:
            page = int(t[5:])
        except ValueError:
            page = None
        tops = [m for m in merged["nodes"] if m.get("pdf_page") == page and m.get("parent_id") is None]
        if tops:
            n["goto_target"] = min(tops, key=lambda m: m.get("order", 0)).get("id")
            resolved += 1
        else:
            n["goto_target"] = None
            unresolved += 1
            notes.append(f"goto from {n.get('id')} to {t} has no top-level node on that page; set to null")
if resolved or unresolved:
    notes.append(f"cross-batch go-to links resolved to the first top-level node of the target page: {resolved}; unresolved: {unresolved}")

# ---- metrics ----
ok = [r for r in results if "input_tokens" in r]
tin, tout = sum(r["input_tokens"] for r in ok), sum(r["output_tokens"] for r in ok)
pin, pout = float(os.environ.get("PRICE_IN_PER_MTOK", 0)), float(os.environ.get("PRICE_OUT_PER_MTOK", 0))
metrics = {"run_id": run_id, "process": "cross_check", "model_id": model_id, "temperature": 0.1,
           "batch_size": batch_size, "max_tokens_per_batch": max_tokens,
           "input_tokens": tin, "output_tokens": tout,
           "latency_seconds": max([r["latency_seconds"] for r in results] or [0]),
           "latency_note": "longest batch; batches ran in parallel",
           "cost_usd": round(tin / 1e6 * pin + tout / 1e6 * pout, 4) if pin or pout else None,
           "pages": doc["page_count"], "doc_sha256": doc["doc_sha256"],
           "batches": [{k: r.get(k) for k in ("batch", "pdf_pages", "input_tokens", "output_tokens",
                                              "latency_seconds", "stop_reason", "json_was_wrapped", "error")}
                       for r in results]}
(here / "run_metrics.json").write_text(json.dumps(metrics, indent=2))

# ---- check each quote appears in its cited block ----
blocks = {b["block_id"]: b["text"] for p in doc["pages"] for b in p["blocks"]}
bad = []
def walk(o):
    if isinstance(o, dict):
        if "block_id" in o and "quote" in o and o["quote"] not in blocks.get(o["block_id"], ""):
            bad.append({"block_id": o["block_id"], "quote": o["quote"]})
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(merged)
failed = [r["batch"] for r in results if r["out"] is None]
merged["_run"] = {"run_id": run_id, "model_id": model_id, "temperature": 0.1, "batches": len(batches),
                  "failed_batches": failed, "merge_notes": notes, "quote_check_failures": bad}
(here / "extraction_output.json").write_text(json.dumps(merged, indent=2, ensure_ascii=False))
print(json.dumps({k: v for k, v in metrics.items() if k != "batches"}, indent=2))
for b in metrics["batches"]: print(b)
print({k: len(merged[k]) for k in LISTS})
print("failed batches:", failed, "| quote failures:", len(bad))
for n in notes: print("note:", n)
