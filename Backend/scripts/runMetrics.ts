// Timing and cost report for one run.
//   npm run metrics -- --url https://api.example.com/runs/<id> [--auth "Bearer ..."] [--html out.html] [--csv out.csv] [--json out.json]
//   npm run metrics -- --file run.json   (a saved GET /runs/:id response: { run, steps })
// Model cost comes from PRICES_JSON (per-million-token prices) when set, otherwise from the costUsd
// already stored on each step. AWS extras use src/metrics/awsRates.ts (override with AWS_RATES_JSON).
import { readFileSync, writeFileSync } from "node:fs";
import { buildRunMetrics } from "../src/metrics/analyze.js";
import { loadAwsRates } from "../src/metrics/awsRates.js";
import { loadPrices } from "../src/metrics/cost.js";
import { renderCsv, renderHtml, renderText } from "../src/metrics/render.js";
import type { Run, StepRecord } from "../src/domain/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function load(): Promise<{ run: Run; steps: StepRecord[] }> {
  const file = arg("file");
  const url = arg("url");
  let body: unknown;
  if (file) body = JSON.parse(readFileSync(file, "utf8"));
  else if (url) {
    const auth = arg("auth");
    const res = await fetch(url, { headers: auth ? { authorization: auth } : {} });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    body = await res.json();
  } else throw new Error("give --url <.../runs/:id> or --file <saved response>");
  const b = body as { run?: Run; steps?: StepRecord[] };
  if (!b.run || !Array.isArray(b.steps)) throw new Error("expected { run, steps } as returned by GET /runs/:id");
  return { run: b.run, steps: b.steps };
}

const { run, steps } = await load();
const prices = loadPrices(process.env);
const metrics = buildRunMetrics(run, steps, { rates: loadAwsRates(), prices: Object.keys(prices).length > 0 ? prices : undefined });
const html = arg("html");
const csv = arg("csv");
const json = arg("json");
if (html) writeFileSync(html, renderHtml(metrics));
if (csv) writeFileSync(csv, renderCsv(metrics));
if (json) writeFileSync(json, JSON.stringify(metrics, null, 2));
console.log(renderText(metrics));
