import type { RunMetrics } from "./analyze.js";

const usd = (n: number | null, digits = 5): string => (n === null ? "unknown" : `$${n.toFixed(digits)}`);
export const fmtMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms - m * 60_000) / 1000).toFixed(1)}s`;
};

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(w[i]!)).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

export function renderText(m: RunMetrics): string {
  const t = m.totals;
  const out: string[] = [
    `Run ${m.runId} (${m.state})  region ${m.generatedFor.region}, rates as of ${m.generatedFor.ratesAsOf}`,
    "",
    `Wall clock ${fmtMs(t.wallClockMs)} = active ${fmtMs(t.activeMs)} + waiting ${fmtMs(t.waitMs)}`,
    `${t.attempts} step attempts, ${t.calls} model calls, tokens in/out ${t.inputTokens}/${t.outputTokens}`,
    `Cost: model ${usd(t.modelCostUsd)} + AWS extras ${usd(t.awsUsd)} = ${usd(t.totalUsd)}`,
    ...(t.unpricedSteps.length ? [`No price for the model used by: ${t.unpricedSteps.join(", ")} (set PRICES_JSON)`] : []),
    "",
    "Per step attempt (cumulative columns include everything up to and including the row)",
    table(
      ["step", "try", "status", "wait", "time", "tok in/out", "model $", "AWS $", "cum time", "cum $"],
      m.steps.map((s) => [
        s.step,
        String(s.attempt),
        s.status,
        fmtMs(s.waitBeforeMs),
        fmtMs(s.latencyMs),
        `${s.inputTokens}/${s.outputTokens}`,
        usd(s.modelCostUsd),
        usd(s.aws.totalUsd),
        fmtMs(s.cumulative.elapsedMs),
        usd(s.cumulative.totalUsd),
      ]),
    ),
  ];
  const calls = m.steps.flatMap((s) => s.calls.map((c) => ({ s, c })));
  if (calls.length > 0) {
    out.push(
      "",
      "Model calls (request to response)",
      table(
        ["step", "try", "call", "backend", "model", "at +", "time", "tok in/out", "model $", "status"],
        calls.map(({ s, c }) => [
          s.step,
          String(s.attempt),
          String(c.seq),
          c.backend,
          c.modelId,
          fmtMs(c.startOffsetMs),
          fmtMs(c.latencyMs),
          `${c.inputTokens}/${c.outputTokens}`,
          usd(c.modelCostUsd),
          c.status,
        ]),
      ),
    );
  }
  out.push(
    "",
    "Per step name (all attempts)",
    table(
      ["step", "attempts", "failed", "calls", "time", "tok in/out", "model $", "AWS $", "total $"],
      m.byStep.map((s) => [s.step, String(s.attempts), String(s.failedAttempts), String(s.calls), fmtMs(s.latencyMs), `${s.inputTokens}/${s.outputTokens}`, usd(s.modelCostUsd), usd(s.awsUsd), usd(s.totalUsd)]),
    ),
    "",
    ...m.notes.map((n) => `Note: ${n}`),
  );
  return out.join("\n");
}

const q = (v: unknown): string => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row per step attempt and one per model call (level column), so a spreadsheet can pivot either.
export function renderCsv(m: RunMetrics): string {
  const head = ["level", "step", "attempt", "call", "backend", "model", "status", "startedAt", "endedAt", "latencyMs", "waitBeforeMs", "inputTokens", "outputTokens", "modelCostUsd", "awsUsd", "totalUsd", "cumElapsedMs", "cumTotalUsd"];
  const rows: unknown[][] = [];
  for (const s of m.steps) {
    rows.push(["step", s.step, s.attempt, "", "", "", s.status, s.startedAt, s.endedAt, s.latencyMs, s.waitBeforeMs, s.inputTokens, s.outputTokens, s.modelCostUsd, s.aws.totalUsd, s.totalUsd, s.cumulative.elapsedMs, s.cumulative.totalUsd]);
    for (const c of s.calls) rows.push(["call", s.step, s.attempt, c.seq, c.backend, c.modelId, c.status, c.startedAt, c.endedAt, c.latencyMs, "", c.inputTokens, c.outputTokens, c.modelCostUsd, "", "", "", ""]);
  }
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Self-contained page (no network): totals, a timeline of steps and calls, cumulative bars, tables.
export function renderHtml(m: RunMetrics): string {
  const t = m.totals;
  const span = Math.max(1, t.wallClockMs);
  const t0 = m.steps[0]?.startedAt ?? 0;
  const maxCost = Math.max(1e-12, ...m.steps.map((s) => s.cumulative.totalUsd ?? 0));
  const lanes = m.steps
    .map((s) => {
      const left = ((s.startedAt - t0) / span) * 100;
      const width = Math.max(0.4, (s.latencyMs / span) * 100);
      const calls = s.calls
        .map((c) => `<i class="call" title="call ${c.seq}: ${esc(fmtMs(c.latencyMs))}, ${c.inputTokens}/${c.outputTokens} tok" style="left:${((c.startedAt - s.startedAt) / Math.max(1, s.latencyMs)) * 100}%;width:${Math.max(1, (c.latencyMs / Math.max(1, s.latencyMs)) * 100)}%"></i>`)
        .join("");
      return `<div class="lane"><span class="lbl">${esc(s.step)} #${s.attempt}</span><div class="track"><b class="bar ${s.status}" style="left:${left}%;width:${width}%" title="${esc(fmtMs(s.latencyMs))}">${calls}</b></div></div>`;
    })
    .join("");
  const rows = m.steps
    .map(
      (s) => `<tr class="${s.status}"><td>${esc(s.step)}</td><td>${s.attempt}</td><td>${s.status}</td><td>${fmtMs(s.waitBeforeMs)}</td><td>${fmtMs(s.latencyMs)}</td><td>${s.inputTokens}/${s.outputTokens}</td><td>${usd(s.modelCostUsd)}</td><td>${usd(s.aws.totalUsd)}</td><td>${fmtMs(s.cumulative.elapsedMs)}</td><td>${usd(s.cumulative.totalUsd)}<div class="cum"><u style="width:${((s.cumulative.totalUsd ?? 0) / maxCost) * 100}%"></u></div></td></tr>` +
        s.calls
          .map((c) => `<tr class="callrow"><td>&nbsp;&nbsp;call ${c.seq} (${c.backend})</td><td></td><td>${c.status}</td><td></td><td>${fmtMs(c.latencyMs)}</td><td>${c.inputTokens}/${c.outputTokens}</td><td>${usd(c.modelCostUsd)}</td><td colspan="3">${esc(c.modelId)}${c.error ? " - " + esc(c.error) : ""}</td></tr>`)
          .join(""),
    )
    .join("");
  const by = m.byStep
    .map((s) => `<tr><td>${esc(s.step)}</td><td>${s.attempts}</td><td>${s.failedAttempts}</td><td>${s.calls}</td><td>${fmtMs(s.latencyMs)}</td><td>${s.inputTokens}/${s.outputTokens}</td><td>${usd(s.modelCostUsd)}</td><td>${usd(s.awsUsd)}</td><td>${usd(s.totalUsd)}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Run ${esc(m.runId)} metrics</title>
<style>
:root{--bg:#fff;--fg:#1a1d21;--mut:#5b6470;--line:#d9dde3;--ok:#2a7f62;--bad:#c0392b;--call:#1f4e9c;--run:#8a6d1c}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8eb;--mut:#9aa3ad;--line:#2c3238;--ok:#4fb391;--bad:#e5776a;--call:#7fa8e8;--run:#d5b25a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;max-width:1200px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}.sub{color:var(--mut)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.tile{border:1px solid var(--line);border-radius:6px;padding:8px 10px}.tile b{display:block;font-size:18px}.tile span{color:var(--mut);font-size:12px}
.lane{display:flex;align-items:center;gap:8px;margin:3px 0}.lbl{width:130px;flex:none;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{position:relative;flex:1;height:16px;background:color-mix(in srgb,var(--line) 40%,transparent);border-radius:3px}
.bar{position:absolute;top:0;height:100%;border-radius:3px;background:var(--ok);overflow:hidden}.bar.failed{background:var(--bad)}.bar.running{background:var(--run)}
.call{position:absolute;top:30%;height:40%;background:var(--call);opacity:.85;border-radius:2px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mut);font-weight:600}
tr.failed td{color:var(--bad)}tr.callrow td{color:var(--mut)}.cum{height:3px;background:var(--line);margin-top:2px}.cum u{display:block;height:3px;background:var(--call)}
.notes{color:var(--mut);font-size:12px}
</style></head><body>
<h1>Run ${esc(m.runId)} - timing and cost</h1><div class="sub">${esc(m.state)} - region ${esc(m.generatedFor.region)}, AWS rates as of ${esc(m.generatedFor.ratesAsOf)}</div>
<div class="tiles">
<div class="tile"><b>${fmtMs(t.wallClockMs)}</b><span>wall clock (${fmtMs(t.activeMs)} active, ${fmtMs(t.waitMs)} waiting)</span></div>
<div class="tile"><b>${usd(t.totalUsd)}</b><span>total cost</span></div>
<div class="tile"><b>${usd(t.modelCostUsd)}</b><span>model tokens</span></div>
<div class="tile"><b>${usd(t.awsUsd)}</b><span>AWS extras (estimate)</span></div>
<div class="tile"><b>${t.calls}</b><span>model calls in ${t.attempts} step attempts</span></div>
<div class="tile"><b>${t.inputTokens}/${t.outputTokens}</b><span>tokens in/out</span></div>
</div>
${t.unpricedSteps.length ? `<p class="notes">No model price for: ${esc(t.unpricedSteps.join(", "))}. Set PRICES_JSON.</p>` : ""}
<h2>Timeline (blue marks are model calls)</h2>${lanes}
<h2>Step by step with cumulative totals</h2><div class="scroll"><table><thead><tr><th>step</th><th>try</th><th>status</th><th>wait</th><th>time</th><th>tok in/out</th><th>model $</th><th>AWS $</th><th>cum time</th><th>cum $</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Per step name</h2><div class="scroll"><table><thead><tr><th>step</th><th>attempts</th><th>failed</th><th>calls</th><th>time</th><th>tok in/out</th><th>model $</th><th>AWS $</th><th>total $</th></tr></thead><tbody>${by}</tbody></table></div>
<h2>Notes</h2><ul class="notes">${m.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
</body></html>`;
}
