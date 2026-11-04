"""Cross-check: the same whole-document extraction as Backend/extraction, run on a second model
(Llama 4 Scout 17B Instruct) on Amazon Bedrock. Saves outputs here.
Needs: AWS credentials, `pip install boto3`, env CROSSCHECK_MODEL_ID (a us. inference profile id).
Settings may also be put in Backend/.env (git-ignored).
Optional env for cost: PRICE_IN_PER_MTOK, PRICE_OUT_PER_MTOK (USD).
Writes: extraction_output.json, run_metrics.json, raw_response.txt in this folder.
"""
import json, os, sys, time
from pathlib import Path
import boto3

def load_env(path):
    if path.is_file():
        for line in path.read_text().splitlines():
            k, _, v = line.strip().partition("=")
            if k and v and not k.startswith("#") and k not in os.environ:
                os.environ[k] = v.strip().strip('"').strip("'")

here = Path(__file__).parent
doc = json.loads((here / "input_blocks.json").read_text())
system = (here / "final_prompt.txt").read_text()
load_env(here.parent / ".env")
model_id = os.environ["CROSSCHECK_MODEL_ID"]
run_id = time.strftime("run-%Y%m%d-%H%M%S")

content = [{"text": f"Run: {run_id}\nSource: {doc['source_id']}   Pages: {doc['page_count']}\n"
                    "Mode: new_guideline\nFor each page, in order:"}]
for p in doc["pages"]:
    content.append({"text": f"--- pdf_page {p['pdf_page']} ---"})
    content.append({"image": {"format": "png", "source": {"bytes": (here / p["image"]).read_bytes()}}})
    content.append({"text": "Blocks: " + json.dumps(p["blocks"], ensure_ascii=False)})
content.append({"text": "Return one JSON object for the whole document."})

client = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-west-2"))
t0 = time.time()
resp = client.converse(modelId=model_id, system=[{"text": system}],
                       messages=[{"role": "user", "content": content}],
                       inferenceConfig={"maxTokens": int(os.environ.get("CROSSCHECK_MAX_TOKENS", 32000)), "temperature": 0})
latency = time.time() - t0
text = "".join(c.get("text", "") for c in resp["output"]["message"]["content"])
(here / "raw_response.txt").write_text(text)

u = resp["usage"]
pin, pout = float(os.environ.get("PRICE_IN_PER_MTOK", 0)), float(os.environ.get("PRICE_OUT_PER_MTOK", 0))
metrics = {"run_id": run_id, "process": "extraction", "model_id": model_id,
           "input_tokens": u["inputTokens"], "output_tokens": u["outputTokens"],
           "latency_seconds": round(latency, 2), "stop_reason": resp["stopReason"],
           "cost_usd": round(u["inputTokens"] / 1e6 * pin + u["outputTokens"] / 1e6 * pout, 4) if pin or pout else None,
           "pages": doc["page_count"], "doc_sha256": doc["doc_sha256"]}
(here / "run_metrics.json").write_text(json.dumps(metrics, indent=2))

# Llama may wrap the JSON in fences or a sentence; take the outermost object and say so.
a, b = text.find("{"), text.rfind("}")
wrapped = text.strip() != text[a:b + 1] if a != -1 and b > a else None
out = json.loads(text[a:b + 1] if a != -1 and b > a else text)
# check each quote appears in its cited block
blocks = {b["block_id"]: b["text"] for p in doc["pages"] for b in p["blocks"]}
bad = []
def walk(o):
    if isinstance(o, dict):
        if "block_id" in o and "quote" in o and o["quote"] not in blocks.get(o["block_id"], ""):
            bad.append({"block_id": o["block_id"], "quote": o["quote"]})
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(out)
out["_run"] = {"run_id": run_id, "model_id": model_id, "json_was_wrapped": wrapped, "quote_check_failures": bad}
(here / "extraction_output.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(json.dumps(metrics, indent=2)); print("quote failures:", len(bad))
