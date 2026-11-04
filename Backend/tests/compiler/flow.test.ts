import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deriveFlow, FLOW_DERIVATION_VERSION, type Flow, type FlowNode } from "../../src/logic/index.js";
import { compileSnapshot } from "../../src/compiler/compileSnapshot.js";
import { assertFlowVerified, flowOptionsFor, prepareFlow } from "../../src/compiler/flowMode.js";
import { buildForm } from "../../src/compiler/form.js";
import { checkCompileReady } from "../../src/compiler/readiness.js";
import { CompileError } from "../../src/compiler/types.js";
import { demoSettings, parse, rawV1, v1 } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "compile-flow-"));
let n = 0;
const fresh = () => join(root, `p${n++}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rowOf = (survey: Array<{ name: string; type: string; relevant?: string }>, name: string, type?: string) => {
  const r = survey.find((x) => x.name === name && (type === undefined || x.type === type));
  if (!r) throw new Error(`no row ${name}`);
  return r;
};

describe("flow modes", () => {
  it("map to deriveFlow options; full means no flow", () => {
    expect(flowOptionsFor("full")).toBeNull();
    expect(flowOptionsFor("minimal")).toEqual({});
    expect(flowOptionsFor("danger_signs_always")).toEqual({ askAllDangerSigns: true });
  });
  it("an unknown flowMode makes the model not compile_ready", () => {
    const r = checkCompileReady(v1(), demoSettings({ flowMode: "smart" as never }));
    expect(r.compile_ready).toBe(false);
    expect(r.missing).toContain("settings.flowMode (one of full, minimal, danger_signs_always)");
  });
});

describe("buildForm with the minimal flow (default)", () => {
  const f = buildForm(v1(), demoSettings(), "v");
  it("is_no steps are emitted as = 'no' on the row and on its group", () => {
    const r = rowOf(f.survey, "not_able_to_drink_or_feed", "select_one yes_no");
    expect(r.relevant).toBe(
      "((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and (${cough} = 'no' or (${cough} = 'yes' and (${cough_days} != '' and ${cough_days} < 14))))",
    );
    expect(rowOf(f.survey, "q_not_able_to_drink_or_feed").relevant).toBe(r.relevant);
    expect(r.relevant).not.toContain("not(");
  });
  it("group relevance equals row relevance for every question; age has none", () => {
    for (const q of v1().questions) {
      expect(rowOf(f.survey, `q_${q.id}`, "begin group").relevant).toBe(rowOf(f.survey, q.id, q.answer_type === "yes_no" ? "select_one yes_no" : "integer").relevant);
    }
    expect(rowOf(f.survey, "age_months", "integer").relevant).toBeUndefined();
  });
  it("authored shown_when AND the flow condition: cough_days keeps the authored cough = yes", () => {
    expect(rowOf(f.survey, "cough_days", "integer").relevant).toBe(
      "((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes')",
    );
  });
  it("the sourcemap marks question rows that carry a flow condition", () => {
    const q = f.sourcemap.filter((e) => e.kind === "question");
    expect(q.find((e) => e.item === "age_months")?.flowCondition).toBeUndefined();
    expect(q.find((e) => e.item === "cough")?.flowCondition).toBe("minimal");
    expect(q.filter((e) => e.flowCondition !== undefined).map((e) => e.item)).toEqual(v1().questions.map((x) => x.id).filter((id) => id !== "age_months"));
  });
  it("flowMode full keeps only the authored shown_when (as before)", () => {
    const full = buildForm(v1(), demoSettings({ flowMode: "full" }), "v");
    expect(rowOf(full.survey, "cough_days", "integer").relevant).toBe("${cough} = 'yes'");
    expect(rowOf(full.survey, "convulsions", "select_one yes_no").relevant).toBeUndefined();
    expect(full.sourcemap.some((e) => e.flowCondition !== undefined)).toBe(false);
  });
  it("danger_signs_always asks every danger sign: convulsions has no relevance", () => {
    const d = buildForm(v1(), demoSettings({ flowMode: "danger_signs_always" }), "v");
    expect(rowOf(d.survey, "convulsions", "select_one yes_no").relevant).toBeUndefined();
    expect(rowOf(d.survey, "breaths_per_minute", "integer").relevant).toBe(
      "((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${cough} = 'yes' and ${chest_indrawing} = 'no')",
    );
  });
  it("a never-asked question gets false() on row and group", () => {
    const raw = rawV1();
    // a question no rule reads: never asked by the minimal flow
    raw.questions.push({ id: "extra_note", order: 10, label: "Anything else?", answer_type: "yes_no", required: true, origin: "team" });
    const m = parse(raw);
    const g = buildForm(m, demoSettings(), "v");
    expect(rowOf(g.survey, "extra_note", "select_one yes_no").relevant).toBe("false()");
    expect(rowOf(g.survey, "q_extra_note").relevant).toBe("false()");
  });
});

describe("refusals", () => {
  it("refuses a deliberately broken flow (a needed question removed from a path) with a CompileError", () => {
    const m = v1();
    const broken: Flow = JSON.parse(JSON.stringify(deriveFlow(m)));
    let done = false;
    const cut = (node: FlowNode): FlowNode => {
      if (!("ask" in node)) return node;
      if (!done && node.ask === "chest_indrawing") {
        done = true;
        return node.branches.find((b) => b.region.kind === "no")!.next;
      }
      return { ask: node.ask, branches: node.branches.map((b) => ({ region: b.region, next: cut(b.next) })) };
    };
    broken.root = cut(broken.root);
    expect(() => assertFlowVerified(m, broken, "minimal")).toThrow(CompileError);
    expect(() => assertFlowVerified(m, broken, "minimal")).toThrow(/flow verification failed/);
    // a broken compiled relevance alone is caught too
    const good = deriveFlow(m);
    const narrow: Flow = { ...good, shownWhen: { ...good.shownWhen, chest_indrawing: { field: "cough", op: "is_yes" } } };
    expect(() => assertFlowVerified(m, narrow, "minimal")).toThrow(CompileError);
    expect(assertFlowVerified(m, good, "minimal").compiled.mismatchCount).toBe(0);
  });
  it("refuses a flow that is too large, nothing written", async () => {
    const dir = fresh();
    await expect(compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings(), flowLimits: { maxNodes: 5 } })).rejects.toThrow(CompileError);
    await expect(compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings(), flowLimits: { maxNodes: 5 } })).rejects.toThrow(/flow is too large/);
    expect(existsSync(dir)).toBe(false);
  });
  it("prepareFlow summarises the flow for the manifest", () => {
    const p = prepareFlow(v1(), "minimal");
    expect(p.summary).toMatchObject({
      mode: "minimal",
      derivationVersion: FLOW_DERIVATION_VERSION,
      nodes: 105,
      leaves: 54,
      questionsAlwaysAsked: ["age_months"],
      neverAsked: [],
      points: 6400,
      treeMismatches: 0,
      compiledMismatches: 0,
      sequenceDifferences: 0,
    });
    expect(p.summary.avgQuestions).toBeCloseTo(3.19, 2);
    expect(p.summary.avgQuestionsFullForm).toBeCloseTo(8.92, 2);
    expect(p.summary.questionsSometimesSkipped).toHaveLength(8);
    const full = prepareFlow(v1(), "full");
    expect(full.flow).toBeNull();
    expect(full.summary).toMatchObject({ mode: "full", derivationVersion: FLOW_DERIVATION_VERSION, nodes: null });
    expect(full.summary.avgQuestions).toBeCloseTo(8.92, 2);
  });
});

describe("compileSnapshot records the flow", () => {
  it("manifest, README and sourcemap carry flowMode, stats and the derivation version; two compiles are identical", async () => {
    const a = fresh();
    const b = fresh();
    const ma = await compileSnapshot(v1(), { projectDir: a, buildKind: "preview", settings: demoSettings({ flowMode: "danger_signs_always" }) });
    const mb = await compileSnapshot(v1(), { projectDir: b, buildKind: "preview", settings: demoSettings({ flowMode: "danger_signs_always" }) });
    expect(ma.flow.mode).toBe("danger_signs_always");
    expect(ma.flow.derivationVersion).toBe(FLOW_DERIVATION_VERSION);
    expect(ma.flow.avgQuestions).toBeCloseTo(8.2, 2);
    expect(ma.files).toEqual(mb.files);
    const readme = readFileSync(join(a, "README.md"), "utf8");
    expect(readme).toContain("## Question flow");
    expect(readme).toContain("- flowMode: danger_signs_always");
    expect(readme).toContain(`- flow derivation version: ${FLOW_DERIVATION_VERSION}`);
    expect(readme).toContain("- average questions asked (grid of 6400 answer combinations): 8.20 (all questions: 8.92)");
    const sm = JSON.parse(readFileSync(join(a, "sourcemap.json"), "utf8"));
    expect(sm.flowMode).toBe("danger_signs_always");
    expect(sm.entries.filter((e: { flowCondition?: string }) => e.flowCondition).map((e: { item: string }) => e.item)).toEqual(["cough_days", "breaths_per_minute"]);
  });
  it("the default compile uses the minimal flow", async () => {
    const m = await compileSnapshot(v1(), { projectDir: fresh(), buildKind: "preview", settings: demoSettings() });
    expect(m.flow.mode).toBe("minimal");
    expect(m.flow.avgQuestions).toBeCloseTo(3.19, 2);
  });
});
