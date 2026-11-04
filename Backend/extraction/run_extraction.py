"""Run whole-document extraction on Amazon Bedrock and save outputs.
Needs: AWS credentials, `pip install boto3`, env MODEL_ID (a us. inference profile id).
Optional env for cost: PRICES_JSON (the server's price map, keyed by model id), or the older PRICE_IN_PER_MTOK / PRICE_OUT_PER_MTOK (USD).
Writes: extraction_output.json, run_metrics.json, raw_response.txt in this folder.
"""
import json, os, sys, time
from pathlib import Path
import boto3
from botocore.config import Config
from usage_cost import cost_usd

here = Path(__file__).parent
doc = json.loads((here / "input_blocks.json").read_text())
system = (here / "final_prompt.txt").read_text()
model_id = os.environ["MODEL_ID"]
run_id = time.strftime("run-%Y%m%d-%H%M%S")

content = [{"text": f"Run: {run_id}\nSource: {doc['source_id']}   Pages: {doc['page_count']}\n"
                    "Mode: new_guideline\nFor each page, in order:"}]
for p in doc["pages"]:
    content.append({"text": f"--- pdf_page {p['pdf_page']} ---"})
    content.append({"image": {"format": "png", "source": {"bytes": (here / p["image"]).read_bytes()}}})
    content.append({"text": "Blocks: " + json.dumps(p["blocks"], ensure_ascii=False)})
content.append({"text": "Return one JSON object for the whole document."})

client = boto3.client("bedrock-runtime", config=Config(read_timeout=900, retries={"total_max_attempts": 1}), region_name="us-west-2")
t0 = time.time()
resp = client.converse(modelId=model_id, system=[{"text": system}],
                       messages=[{"role": "user", "content": content}],
                       inferenceConfig={"maxTokens": 32000})
latency = time.time() - t0
blocks_out = resp["output"]["message"]["content"]
text = "".join(c.get("text", "") for c in blocks_out)  # the reply may start with a non-text block
(here / "raw_response.txt").write_text(text)

u = resp["usage"]
cost = cost_usd(os.environ, model_id, u["inputTokens"], u["outputTokens"])
metrics = {"run_id": run_id, "process": "extraction", "model_id": model_id,
           "input_tokens": u["inputTokens"], "output_tokens": u["outputTokens"],
           "latency_seconds": round(latency, 2), "stop_reason": resp["stopReason"],
           "cost_usd": round(cost, 4) if cost is not None else None,
           "pages": doc["page_count"], "doc_sha256": doc["doc_sha256"],
           "content_block_types": [list(c.keys())[0] for c in blocks_out]}
(here / "run_metrics.json").write_text(json.dumps(metrics, indent=2))

out = json.loads(text)
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
out["_run"] = {"run_id": run_id, "quote_check_failures": bad}
(here / "extraction_output.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(json.dumps(metrics, indent=2)); print("quote failures:", len(bad))
