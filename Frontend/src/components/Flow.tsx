import { useMemo, useState } from "react";
import dagre from "dagre";
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toGraph, type GKind } from "../../../shared/pathway/index.ts";
import { sevColor } from "../domain/data";
import { condText, getO, getR, usesOf } from "../domain/logic";
import type { Model } from "../domain/types";

export type Badge = [cls: string, label: string];
export type Markers = Record<string, Badge[]>;
export type Tone = Record<string, "changed" | "bad">;

type Kind = GKind;
interface FlowNode { id: string; type: Kind; color?: string; text: string; sub?: string }

const WIDTH: Record<Kind, number> = { start: 230, decision: 240, outcome: 230, task: 210 };
const KICK: Record<Kind, string> = { decision: "Rule", outcome: "Classify", task: "Follow-up task", start: "Applies to" };

/** The compiled flow graph, with text for each box. */
function toNodes(m: Model) {
  const g = toGraph(m);
  const nodes: FlowNode[] = g.nodes.map(n => {
    switch (n.kind) {
      case "start": {
        const below = m.scope.age_months_below;
        const yrs = below % 12 === 0 ? below / 12 + " years" : below + " months";
        return { id: n.id, type: n.kind, text: "Child " + m.scope.age_months_min + " months up to " + yrs, sub: m.questions.length + " questions · " + m.rules.length + " rules, first match wins" };
      }
      case "decision": {
        const r = getR(m, n.key)!;
        const c = r.when === "otherwise" ? "otherwise" : condText(m, r.when);
        const qs = usesOf(m, n.id);
        return { id: n.id, type: n.kind, text: c[0].toUpperCase() + c.slice(1) + "?", sub: r.id + " · reads " + (qs.length ? qs.length + " question" + (qs.length > 1 ? "s" : "") : "no questions") };
      }
      case "outcome": {
        const o = getO(m, n.key)!;
        return { id: n.id, type: n.kind, color: sevColor(o.severity), text: o.title, sub: o.actions.map(a => a.text).join(" ") };
      }
      case "task": {
        const f = getO(m, n.key)!.follow_up!;
        return { id: n.id, type: n.kind, text: (f.kind === "scheduled" ? "Follow-up visit" : "Follow up on return") + (f.due_in_days !== null ? ": due day " + f.due_in_days : "") + (f.task_window_days_after_due !== null ? ", open " + f.task_window_days_after_due + " more days" : "") };
      }
    }
  });
  return { nodes, edges: g.edges.map(e => [e.from, e.to, e.label] as [string, string, string]) };
}
function estHeight(n: FlowNode, width: number = WIDTH[n.type]): number {
  const w = width - 22;
  const main = Math.max(1, Math.ceil(n.text.length / Math.floor(w / (n.type === "outcome" ? 7.6 : 7.3))));
  const sub = n.sub ? Math.ceil(n.sub.length / Math.floor(w / 6.6)) : 0;
  return 16 + 16 + main * 18 + sub * 16 + (sub ? 4 : 0) + (n.type === "outcome" ? 6 : 0) + 8;
}
type Dir = "TB" | "LR";
type BoxData = { n: FlowNode; badges: Badge[]; tone?: "changed" | "bad"; sel: boolean; dir: Dir };

/** One box in the flow. Read-only: no handles to drag from, clicks only select. */
function Box({ data }: NodeProps<Node<BoxData>>) {
  const { n, badges, tone, sel, dir } = data;
  const cls = ["node", n.type, n.color ? "o-" + n.color : "", tone === "changed" ? "d-changed" : "", tone === "bad" ? "d-changed bad" : "", sel ? "sel" : ""].join(" ");
  return (
    <div className={cls} style={{ width: WIDTH[n.type] }} aria-label={KICK[n.type] + ": " + n.text}>
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} isConnectable={false} />
      <div className="kick">
        <span>{KICK[n.type]}</span>
        <span className="badges">{badges.map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
      </div>
      {n.type === "outcome"
        ? <><div className="ttl">{n.text}</div><div className="sub">{n.sub}</div></>
        : <><div>{n.text}</div>{n.sub ? <div className="sub">{n.sub}</div> : null}</>}
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { box: Box };

/** dagre layout, as in the React Flow dagre example: dagre gives centres, React Flow wants top-left corners. */
function layout(nodes: FlowNode[], edges: [string, string, string][], dir: Dir) {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: dir, nodesep: 30, ranksep: dir === "TB" ? 50 : 70 });
  nodes.forEach(n => g.setNode(n.id, { width: WIDTH[n.type], height: estHeight(n) }));
  edges.forEach(([a, b]) => g.setEdge(a, b));
  dagre.layout(g);
  return new Map(nodes.map(n => { const p = g.node(n.id); return [n.id, { x: p.x - WIDTH[n.type] / 2, y: p.y - estHeight(n) / 2 }]; }));
}

interface Props { m: Model; selected?: string; onSelect?: (id: string) => void; markers?: Markers; tone?: Tone; label: string }

export function Flow({ m, selected, onSelect, markers = {}, tone = {}, label }: Props) {
  const [dir, setDir] = useState<Dir>("TB");
  const { nodes: fns, edges: fes } = toNodes(m);
  const key = JSON.stringify([fns, fes, dir]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pos = useMemo(() => layout(fns, fes, dir), [key]);

  const nodes: Node<BoxData>[] = fns.map(n => ({
    id: n.id, type: "box", position: pos.get(n.id)!, draggable: false, connectable: false,
    data: { n, badges: markers[n.id] || [], tone: tone[n.id], sel: selected === n.id, dir },
  }));
  const edges: Edge[] = fes.map(([a, b, l]) => ({
    id: a + "->" + b, source: a, target: b, type: "smoothstep", label: l && l !== "task" ? l : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: l === "task" ? { strokeDasharray: "5 4" } : undefined,
    labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4,
  }));

  // Open readable: fit the start box, the first three rules and what they lead to. The fit button shows everything.
  const firstRules = fns.filter(n => n.type === "decision").slice(0, 3).map(n => n.id);
  const focus = fns.filter(n => n.type === "start" || firstRules.includes(n.id) || fes.some(([a, b, l]) => firstRules.includes(a) && b === n.id && l === "yes")).map(n => ({ id: n.id }));

  return (
    <div className="rfwrap" role="group" aria-label={label}>
      <ReactFlow key={dir} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.06, nodes: focus }}
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false}
        onNodeClick={(_e, n) => onSelect?.(n.id)} minZoom={0.2} proOptions={{ hideAttribution: true }}>
        <Panel position="top-right">
          <div className="viewtgl" role="group" aria-label="Layout">
            <button type="button" aria-pressed={dir === "TB"} onClick={() => setDir("TB")}>Vertical</button>
            <button type="button" aria-pressed={dir === "LR"} onClick={() => setDir("LR")}>Horizontal</button>
          </div>
        </Panel>
        <Controls showInteractive={false} />
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
