import { deriveFlow, regionWords, type Flow, type FlowNode, type Model } from "../logic/index.js";

export interface FlowNodeInfo {
  /** Stable: question id, rule id, or "<questionId>:<min>-<below>" for a range region. */
  nodeId: string;
  kind: "ask" | "leaf" | "region";
  questionId?: string;
  ruleId?: string;
  label: string;
  editable: string[];
}

/** The tree plus one entry per editable thing in it (each question, leaf rule and range region once). */
export function describeFlowNodes(model: Model): { flow: Flow; nodes: FlowNodeInfo[] } {
  const flow = deriveFlow(model);
  const qs = new Map(model.questions.map((q) => [q.id, q]));
  const nodes: FlowNodeInfo[] = [];
  const seen = new Set<string>();
  const add = (n: FlowNodeInfo): void => {
    if (!seen.has(n.nodeId)) {
      seen.add(n.nodeId);
      nodes.push(n);
    }
  };
  const visit = (n: FlowNode): void => {
    if ("leaf" in n) {
      const rule = model.rules.find((r) => r.id === n.rule);
      const o = model.outcomes.find((x) => x.id === rule?.outcome);
      add({
        nodeId: n.rule,
        kind: "leaf",
        ruleId: n.rule,
        label: o?.title ?? n.leaf,
        editable: o?.follow_up ? ["title", "action", "follow_up_days"] : ["title", "action"],
      });
      return;
    }
    const q = qs.get(n.ask);
    if (q) add({ nodeId: q.id, kind: "ask", questionId: q.id, label: q.label, editable: ["label"] });
    for (const b of n.branches) {
      if (q && b.region.kind === "range" && (b.region.min !== null || b.region.below !== null)) {
        add({
          nodeId: `${q.id}:${b.region.min ?? ""}-${b.region.below ?? ""}`,
          kind: "region",
          questionId: q.id,
          label: `${q.label} ${regionWords(b.region, q)}`,
          editable: ["threshold"],
        });
      }
      visit(b.next);
    }
  };
  visit(flow.root);
  return { flow, nodes };
}
