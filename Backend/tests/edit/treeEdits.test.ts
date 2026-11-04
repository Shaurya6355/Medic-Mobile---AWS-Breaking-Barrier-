import { describe, expect, it } from "vitest";
import { describeFlowNodes } from "../../src/edit/flowNodes.js";
import { previewEdits } from "../../src/edit/preview.js";
import { applyTreeEdits, type TreeEdit } from "../../src/edit/treeEdits.js";
import { canonicalJson, evaluate, parseModel } from "../../src/logic/index.js";
import { draftV1 } from "../signoff/helpers.js";

const m = draftV1();
const before = canonicalJson(m);

describe("applyTreeEdits", () => {
  it("setQuestionLabel", () => {
    const r = applyTreeEdits(m, [{ op: "setQuestionLabel", questionId: "cough", text: "Is there a cough?" }]);
    expect(r.ok && r.paths).toEqual(["questions[1].label"]);
    expect(r.ok && r.model.questions[1]!.label).toBe("Is there a cough?");
  });
  it("setThreshold edits the derived cut-off the rule reads", () => {
    const r = applyTreeEdits(m, [{ op: "setThreshold", questionId: "breaths_per_minute", ruleId: "R5", from: 50, to: 55 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]).toMatch(/^derived\[\d+\]\.definition\..*\.value$/);
    expect(parseModel(r.model).ok).toBe(true);
    expect(canonicalJson(r.model)).not.toBe(before);
  });
  it("setOutcomeText and setFollowUpDays", () => {
    const t = applyTreeEdits(m, [{ op: "setOutcomeText", ruleId: "R4", field: "title", text: "Refer now" }]);
    expect(t.ok && t.paths[0]).toMatch(/^outcomes\[\d+\]\.title$/);
    const a = applyTreeEdits(m, [{ op: "setOutcomeText", ruleId: "R4", field: "action", actionIndex: 1, text: "Write note." }]);
    expect(a.ok && a.paths[0]).toMatch(/actions\[1\]\.text$/);
    const f = applyTreeEdits(m, [{ op: "setFollowUpDays", ruleId: "R4", days: 3 }]);
    expect(f.ok && f.paths[0]).toMatch(/follow_up\.due_in_days$/);
    expect(f.ok && f.model.outcomes.find((o) => o.id === "refer_urgent")!.follow_up!.due_in_days).toBe(3);
  });
  it("unsupported and invalid edits", () => {
    const u = applyTreeEdits(m, [{ op: "removeQuestion", questionId: "cough" } as unknown as TreeEdit]);
    expect(!u.ok && u.code).toBe("unsupported_edit");
    expect(!applyTreeEdits(m, [{ op: "setThreshold", questionId: "breaths_per_minute", ruleId: "R5", from: 51, to: 55 }]).ok).toBe(true);
    const i = applyTreeEdits(m, [{ op: "setQuestionLabel", questionId: "nope", text: "x" }]);
    expect(!i.ok && i.code).toBe("invalid_edit");
    const e = applyTreeEdits(m, [{ op: "setQuestionLabel", questionId: "cough", text: " " }]);
    expect(!e.ok && e.code).toBe("invalid_edit");
  });
  it("never mutates the original or meta versions", () => {
    const r = applyTreeEdits(m, [{ op: "setQuestionLabel", questionId: "cough", text: "Changed?" }]);
    expect(canonicalJson(m)).toBe(before);
    expect(r.ok && r.model.meta.version).toBe(m.meta.version);
    expect(r.ok && r.model.meta.parent_version).toEqual(m.meta.parent_version);
  });
});

describe("flow nodes and preview", () => {
  it("describes stable nodes", () => {
    const { flow, nodes } = describeFlowNodes(m);
    expect(flow.root).toBeDefined();
    const ids = nodes.map((n) => n.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(nodes.some((n) => n.kind === "ask" && n.editable.includes("label"))).toBe(true);
    expect(nodes.some((n) => n.kind === "leaf" && n.ruleId)).toBe(true);
    expect(nodes.some((n) => n.kind === "region" && n.editable[0] === "threshold")).toBe(true);
    expect(describeFlowNodes(m).nodes.map((n) => n.nodeId)).toEqual(ids);
  });
  it("detects behaviour change on a threshold move", () => {
    const p = previewEdits(m, [{ op: "setThreshold", questionId: "breaths_per_minute", ruleId: "R5", from: 50, to: 55 }]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.behaviourChanges.total).toBeGreaterThan(0);
    const s = p.behaviourChanges.samples[0]!;
    expect(evaluate(m, s.answers).outcome).toBe(s.before);
    expect(evaluate(p.model, s.answers).outcome).toBe(s.after);
  });
  it("label edit changes no behaviour; unsupported passes through", () => {
    const p = previewEdits(m, [{ op: "setQuestionLabel", questionId: "cough", text: "Cough?" }]);
    expect(p.ok && p.behaviourChanges.total).toBe(0);
    expect(previewEdits(m, [{ op: "addQuestion" } as unknown as TreeEdit]).ok).toBe(false);
  });
});
