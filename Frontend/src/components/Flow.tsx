import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import dagre from "dagre";
import { COND } from "../domain/data";
import { usesOf } from "../domain/logic";
import type { Model, NodeId } from "../domain/types";

export type Badge = [cls: string, label: string];
export type Markers = Record<string, Badge[]>;
export type Tone = Record<string, "changed" | "bad">;

type Kind = "start" | "decision" | "outcome" | "task";
interface FlowNode { id: NodeId; type: Kind; color?: string; text: string; sub?: string }

const EDGES: [NodeId, NodeId, string][] = [["start", "d1", ""], ["d1", "o1", "yes"], ["d1", "d2", "no"], ["d2", "o1", "yes"], ["d2", "d3", "no"], ["d3", "o2", "yes"], ["d3", "o3", "no"], ["o2", "f1", "task"]];
const WIDTH: Record<Kind, number> = { start: 230, decision: 230, outcome: 230, task: 210 };
const KICK: Record<Kind, string> = { decision: "Question", outcome: "Classify", task: "Follow-up task", start: "Applies to" };

function toNodes(m: Model): FlowNode[] {
  const yrs = m.start.ageMax % 12 === 0 ? m.start.ageMax / 12 + " years" : m.start.ageMax + " months";
  const yes = (id: "d2" | "d3") => "Yes if: " + (m[id].conds.map(c => COND[c].toLowerCase()).join(" or ") || "no condition set");
  return [
    { id: "start", type: "start", text: "Child " + m.start.ageMin + " months up to " + yrs + " with cough or difficult breathing", sub: "Asks " + usesOf(m, "start").length + " questions" },
    { id: "d1", type: "decision", text: m.d1.q, sub: "Yes if any of " + m.d1.signs.length + " danger signs" },
    { id: "d2", type: "decision", text: m.d2.q, sub: yes("d2") },
    { id: "d3", type: "decision", text: m.d3.q, sub: yes("d3") + (m.d3.conds.includes("fast") ? ". Fast: " + m.d3.young + "/min or more under " + m.d3.cut + " months, " + m.d3.old + " or more after" : "") },
    { id: "o1", type: "outcome", color: "pink", text: m.o1.title, sub: m.o1.note },
    { id: "o2", type: "outcome", color: "yellow", text: m.o2.title, sub: m.o2.note },
    { id: "o3", type: "outcome", color: "green", text: m.o3.title, sub: m.o3.note },
    { id: "f1", type: "task", text: m.f1.title + ": due day " + m.f1.due + ", open until day " + m.f1.end },
  ];
}
function estHeight(n: FlowNode): number {
  const w = WIDTH[n.type] - 22;
  const main = Math.max(1, Math.ceil(n.text.length / Math.floor(w / (n.type === "outcome" ? 7.6 : 7.3))));
  const sub = n.sub ? Math.ceil(n.sub.length / Math.floor(w / 6.6)) : 0;
  return 16 + 16 + main * 18 + sub * 16 + (sub ? 4 : 0) + (n.type === "outcome" ? 6 : 0) + 8;
}
function layout(nodes: FlowNode[]) {
  const g = new dagre.graphlib.Graph<{ n: FlowNode }>();
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 34, marginx: 6, marginy: 6 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(n => g.setNode(n.id, { width: WIDTH[n.type], height: estHeight(n), n }));
  EDGES.forEach(([a, b, l]) => g.setEdge(a, b, { label: l, width: l ? l.length * 6.5 + 10 : 0, height: l ? 16 : 0, labelpos: "c" }));
  dagre.layout(g);
  return g;
}
function smooth(p: { x: number; y: number }[]): string {
  let d = "M" + p[0].x + "," + p[0].y;
  if (p.length === 2) return d + " L" + p[1].x + "," + p[1].y;
  for (let i = 1; i < p.length - 1; i++) {
    const last = i === p.length - 2;
    const ex = last ? p[i + 1].x : (p[i].x + p[i + 1].x) / 2, ey = last ? p[i + 1].y : (p[i].y + p[i + 1].y) / 2;
    d += " Q" + p[i].x + "," + p[i].y + " " + ex + "," + ey;
  }
  return d;
}

interface Props { m: Model; selected?: string; onSelect?: (id: string) => void; markers?: Markers; tone?: Tone; label: string }

export function Flow({ m, selected, onSelect, markers = {}, tone = {}, label }: Props) {
  const nodes = toNodes(m);
  const key = JSON.stringify(nodes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g = useMemo(() => layout(nodes), [key]);
  const W = Math.ceil(g.graph().width || 0), H = Math.ceil(g.graph().height || 0);
  const ref = useRef<HTMLDivElement>(null);
  const mk = "ah" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [W]);

  return (
    <div ref={ref} className="stage" style={{ height: H * scale }} role="group" aria-label={label}>
      <div className="canvas" style={{ width: W, height: H, transform: "scale(" + scale + ")" }}>
        <svg width={W} height={H} aria-hidden="true">
          <defs>
            <marker id={mk} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path className="ah" d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
          {g.edges().map((e, i) => {
            const ed = g.edge(e) as dagre.GraphEdge & { label?: string; width?: number };
            return (
              <g key={i}>
                <path className="edge" d={smooth(ed.points)} markerEnd={"url(#" + mk + ")"} strokeDasharray={e.w === "f1" ? "5 4" : undefined} />
                {ed.label ? (
                  <g className="elbl">
                    <rect x={(ed.x || 0) - (ed.width || 0) / 2} y={(ed.y || 0) - 8} width={ed.width} height={16} rx={4} />
                    <text x={ed.x} y={(ed.y || 0) + 4} textAnchor="middle">{ed.label}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
        {g.nodes().map(id => {
          const nd = g.node(id), n = nd.n, t = tone[id];
          const cls = ["node", n.type, n.color ? "o-" + n.color : "", t === "changed" ? "d-changed" : "", t === "bad" ? "d-changed bad" : "", selected === id ? "sel" : ""].join(" ");
          return (
            <button key={id} type="button" className={cls} aria-pressed={selected === id} aria-label={KICK[n.type] + ": " + n.text}
              style={{ left: nd.x - nd.width / 2, top: nd.y - nd.height / 2, width: nd.width, minHeight: nd.height }}
              onClick={() => onSelect?.(id)}>
              <div className="kick">
                <span>{KICK[n.type]}</span>
                <span className="badges">{(markers[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
              </div>
              {n.type === "outcome"
                ? <><div className="ttl">{n.text}</div><div className="sub">{n.sub}</div></>
                : <><div>{n.text}</div>{n.sub ? <div className="sub">{n.sub}</div> : null}</>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
