// Writes output/flow.md (Mermaid + plain sentences) and output/flow.html (offline Mermaid rendering)
// for the derived question flow. Imported by run.mjs (tsx, so the TypeScript sources load directly).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  deriveFlow,
  describeFlow,
  describeFlowByOutcome,
  evalFlowCondition,
  flowToMermaid,
  FLOW_DERIVATION_VERSION,
  verifyFlow,
  walkFlow,
} from "../src/logic/index.js";
import { flowOptionsFor } from "../src/compiler/flowMode.js";

const MODES = ["minimal", "danger_signs_always"];
const MODE_WORDS = {
  minimal: "minimal: only questions that can still change the outcome",
  danger_signs_always: "danger_signs_always: as minimal, but every danger-sign question is always asked",
  full: "full: every question its authored shown_when allows",
};

/** Questions shown with authored shown_when only (flowMode full), in model order. */
function fullSequence(model, answers) {
  const form = {};
  const out = [];
  for (const q of model.questions) {
    if (evalFlowCondition(q.shown_when ?? null, form)) {
      out.push(q.id);
      if (answers[q.id] !== undefined) form[q.id] = answers[q.id];
    }
  }
  return out;
}

function ensureMermaid(previewDir) {
  const bundle = join(previewDir, "node_modules", "mermaid", "dist", "mermaid.min.js");
  if (!existsSync(bundle)) {
    const lock = existsSync(join(previewDir, "package-lock.json"));
    const r = spawnSync("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: previewDir, stdio: "inherit" });
    if (r.status !== 0 || !existsSync(bundle)) throw new Error("could not install mermaid in compile-demo/preview");
  }
  return bundle;
}

export async function writeFlowOutputs({ model, outDir, previewDir, compiledMode, golden, modelSha }) {
  const qLabel = new Map(model.questions.map((q) => [q.id, q.label]));
  const modes = MODES.map((mode) => {
    const flow = deriveFlow(model, flowOptionsFor(mode));
    const v = verifyFlow(model, flow);
    return { mode, flow, v, mermaid: flowToMermaid(flow, model), groups: describeFlowByOutcome(flow, model), overview: describeFlow(flow, model).filter((l) => !l.includes("the form ends:")) };
  });
  const byMode = Object.fromEntries(modes.map((m) => [m.mode, m]));
  const goldenRows = golden.map((g) => ({
    id: g.id,
    description: g.description,
    minimal: walkFlow(byMode.minimal.flow, g.answers).asked,
    danger: walkFlow(byMode.danger_signs_always.flow, g.answers).asked,
    full: fullSequence(model, g.answers),
  }));
  const avg = (rows, k) => (rows.reduce((a, r) => a + r[k].length, 0) / (rows.length || 1)).toFixed(2);

  // ------------------------------------------------------------------ flow.md
  const md = [];
  md.push(
    "# Question flow (derived from the logic model)",
    "",
    `Preview build, not approved. Synthetic data only. Model \`${model.meta.pathway_id}\` v${model.meta.version}, modelSha \`${modelSha}\`, flow derivation version \`${FLOW_DERIVATION_VERSION}\`. The compiled form in \`project/\` uses **flowMode ${compiledMode}**.`,
    "",
    "The form asks one question per screen and only the questions that can still change the outcome. The flow is",
    "computed from the rule table by code (it is not part of the signed model) and checked on every one of the",
    `${modes[0].v.points} answer combinations of the exact grid: the short form gives the same outcome as answering everything.`,
    "",
    "**Clinician's choice.** The minimal flow never asks a question once the outcome is already decided. Under the final",
    "model a child outside 2 to 59 months is still asked about cough and the danger signs (rule R1 refers a child outside the",
    "age range with a danger sign urgently), so a 1-month-old with convulsions is asked about convulsions and referred urgently.",
    "`danger_signs_always` asks every danger-sign question in every case.",
    "",
    "| flow mode | average questions (grid) | average questions (15 golden cases) | always asked | sometimes skipped | never asked | tree nodes / leaves | mismatches (tree / compiled) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const m of modes) {
    md.push(
      `| ${m.mode} | ${m.v.compiled.avgQuestions.toFixed(2)} | ${avg(goldenRows, m.mode === "minimal" ? "minimal" : "danger")} | ${m.flow.stats.questionsAlwaysAsked.join(", ") || "none"} | ${m.flow.stats.questionsSometimesSkipped.length} questions | ${m.flow.stats.neverAsked.join(", ") || "none"} | ${m.flow.stats.nodes} / ${m.flow.stats.leaves} | ${m.v.mismatchCount} / ${m.v.compiled.mismatchCount} |`,
    );
  }
  md.push(`| full | ${modes[0].v.avgQuestionsFullForm.toFixed(2)} | ${avg(goldenRows, "full")} | (authored shown_when only) | | | | |`, "");
  md.push("Grid averages weight every answer combination equally (half of them have an out-of-range age), not real patients.", "");
  md.push("## Questions asked per golden case", "", "| case | description | minimal | danger_signs_always | full |", "| --- | --- | --- | --- | --- |");
  for (const r of goldenRows) md.push(`| ${r.id} | ${r.description} | ${r.minimal.length} | ${r.danger.length} | ${r.full.length} |`);
  md.push("");
  for (const m of modes) {
    md.push(`## ${MODE_WORDS[m.mode]}`, "", ...m.overview.map((l) => `- ${l}`), "", "### How the form can end", "");
    for (const g of m.groups) {
      md.push(`<details><summary><strong>${g.title}</strong> (${g.when.length} ${g.when.length === 1 ? "way" : "ways"})</summary>`, "", ...g.when.map((w) => `- ${w}`), "", "</details>", "");
    }
    md.push("### Diagram", "", "```mermaid", m.mermaid, "```", "");
  }
  writeFileSync(join(outDir, "flow.md"), md.join("\n"));

  // ------------------------------------------------------------------ flow.html (offline)
  copyFileSync(ensureMermaid(previewDir), join(outDir, "mermaid.min.js"));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const section = (m) => `
<section id="${m.mode}">
<h2>${esc(MODE_WORDS[m.mode])}${m.mode === compiledMode ? ' <span class="tag">compiled form</span>' : ""}</h2>
<p>Average questions over the ${m.v.points}-combination grid: <strong>${m.v.compiled.avgQuestions.toFixed(2)}</strong> (all questions: ${m.v.avgQuestionsFullForm.toFixed(2)}). Mismatches against answering everything: ${m.v.mismatchCount} (tree), ${m.v.compiled.mismatchCount} (compiled form).</p>
<ul>${m.overview.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<details><summary>How the form can end (${m.groups.reduce((a, g) => a + g.when.length, 0)} ways)</summary>
${m.groups.map((g) => `<h4>${esc(g.title)}</h4><ul>${g.when.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`).join("\n")}
</details>
<div class="diagram"><pre class="mermaid">${esc(m.mermaid)}</pre></div>
</section>`;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Question flow: ${esc(model.meta.pathway_id)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5em;color:#222;max-width:1400px}
.banner{background:#fff3cd;border:1px solid #e0c060;padding:8px;margin-bottom:1em}
.choice{background:#eef3fb;border:1px solid #9bb5dd;padding:8px;margin:1em 0}
.tag{font-size:12px;background:#2a6;color:#fff;padding:2px 6px;border-radius:3px;vertical-align:middle}
.diagram{overflow:auto;border:1px solid #ddd;padding:8px;background:#fff}
table{border-collapse:collapse;font-size:13px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left}
section{margin-top:2em}
</style></head><body>
<div class="banner"><strong>Preview build, not approved.</strong> Synthetic data only. Model <code>${esc(model.meta.pathway_id)}</code> v${esc(model.meta.version)}, modelSha <code>${esc(modelSha)}</code>, flow derivation <code>${esc(FLOW_DERIVATION_VERSION)}</code>. Compiled form: flowMode <strong>${esc(compiledMode)}</strong>. Renders offline (mermaid ${esc(JSON.parse(readFileSync(join(previewDir, "node_modules", "mermaid", "package.json"), "utf8")).version)} bundled next to this page).</div>
<h1>Question flow</h1>
<p>One question per screen; only questions that can still change the outcome are asked. Checked on every answer combination: same outcome as answering everything.</p>
<div class="choice"><strong>Clinician's choice.</strong> The minimal flow never asks a question once the outcome is decided. Under the final model a child outside 2 to 59 months is still asked about cough and the danger signs (rule R1 refers such a child with a danger sign urgently). <code>danger_signs_always</code> asks every danger-sign question in every case.</div>
<table><thead><tr><th>case</th><th>description</th><th>minimal</th><th>danger_signs_always</th><th>full</th></tr></thead><tbody>
${goldenRows.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.description)}</td><td>${r.minimal.length}: ${esc(r.minimal.map((id) => qLabel.get(id)).join(" / "))}</td><td>${r.danger.length}</td><td>${r.full.length}</td></tr>`).join("\n")}
</tbody></table>
${modes.map(section).join("\n")}
<script src="mermaid.min.js"></script>
<script>
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 500000, maxEdges: 5000, flowchart: { useMaxWidth: false } });
mermaid.run({ querySelector: "pre.mermaid" }).then(() => { document.body.dataset.rendered = "yes"; }, (e) => { document.body.dataset.rendered = "error: " + e; });
</script>
</body></html>
`;
  writeFileSync(join(outDir, "flow.html"), html);
  return { modes: modes.map((m) => ({ mode: m.mode, avgQuestions: m.v.compiled.avgQuestions, nodes: m.flow.stats.nodes, leaves: m.flow.stats.leaves })), goldenRows };
}
