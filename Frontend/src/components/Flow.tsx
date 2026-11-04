import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
interface Pt { x: number; y: number }
interface LNode { x: number; y: number; width: number; height: number; n: FlowNode }
interface LEdge { points: Pt[]; label?: string; width?: number; x?: number; y?: number }

/** Decision-table layout: rules stacked in priority order, each rule's outcome beside it, its follow-up task beside that.
    The compiler always emits a first-match chain, so this reads like the rule table it is. */
function layout(nodes: FlowNode[], edges: [string, string, string][]) {
  const GAP_X = 40, GAP_Y = 34, M = 6;
  const W = { decision: 230, outcome: 220, task: 160 };
  const col: Record<string, number> = {}, row: Record<string, number> = {};
  const chain = nodes.filter(n => n.type === "start" || n.type === "decision").map(n => n.id);
  chain.forEach((id, i) => { col[id] = 0; row[id] = i; });
  let nextRow = chain.length;
  edges.forEach(([a, b, l]) => {
    if (b in row) return;
    if (l === "yes") { col[b] = 1; row[b] = row[a]; }
    else if (l === "no" || l === "") { col[b] = 0; row[b] = nextRow++; }
  });
  nodes.filter(n => n.type === "outcome" && !(n.id in row)).forEach(n => { col[n.id] = 1; row[n.id] = nextRow++; });
  edges.forEach(([a, b, l]) => { if (l === "task" && !(b in row)) { col[b] = col[a] + 1; row[b] = row[a]; } });

  const colW = [W.decision, W.outcome, W.task].map((w, c) => (c === 0 ? w : Math.max(w, ...nodes.filter(n => col[n.id] === c).map(n => (n.type === "task" ? W.task : W.outcome)))));
  const colX: number[] = []; let x = M;
  colW.forEach((w, c) => { colX[c] = x + w / 2; x += w + GAP_X; });
  const rowH: number[] = Array(nextRow).fill(0);
  const width = (n: FlowNode) => (col[n.id] === 0 ? W.decision : n.type === "task" ? W.task : W.outcome);
  nodes.forEach(n => { rowH[row[n.id]] = Math.max(rowH[row[n.id]], estHeight(n, width(n))); });
  const rowY: number[] = []; let y = M;
  rowH.forEach((h, r) => { rowY[r] = y; y += h + GAP_Y; });

  const L = new Map<string, LNode>();
  nodes.forEach(n => {
    const w = width(n), h = estHeight(n, w);
    L.set(n.id, { x: colX[col[n.id]], y: rowY[row[n.id]] + h / 2, width: w, height: h, n });
  });
  const E: { v: string; w: string; e: LEdge }[] = edges.filter(([a, b]) => L.has(a) && L.has(b)).map(([a, b, l]) => {
    const A = L.get(a)!, B = L.get(b)!;
    let pts: Pt[];
    if (col[a] === col[b]) pts = [{ x: A.x, y: A.y + A.height / 2 }, { x: B.x, y: B.y - B.height / 2 }];
    else {
      // Boxes are top-aligned per row; leave and enter every side edge at the same height so arrows stay level.
      const ya = rowY[row[a]] + 28, yb = rowY[row[b]] + 28, mx = A.x + A.width / 2 + GAP_X / 2;
      pts = row[a] === row[b] ? [{ x: A.x + A.width / 2, y: ya }, { x: B.x - B.width / 2, y: yb }]
        : [{ x: A.x + A.width / 2, y: ya }, { x: mx, y: ya }, { x: mx, y: yb }, { x: B.x - B.width / 2, y: yb }];
    }
    const mid = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { x: pts[1].x, y: (pts[1].y + pts[2].y) / 2 };
    return { v: a, w: b, e: { points: pts, label: l === "task" ? "" : l, width: l ? l.length * 6.5 + 10 : 0, x: mid.x, y: mid.y } };
  });
  return {
    graph: () => ({ width: x - GAP_X + M, height: y - GAP_Y + M }),
    nodes: () => [...L.keys()],
    node: (id: string) => L.get(id)!,
    edges: () => E.map(({ v, w }) => ({ v, w })),
    edge: (k: { v: string; w: string }) => E.find(e => e.v === k.v && e.w === k.w)!.e,
  };
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
  const { nodes, edges } = toNodes(m);
  const key = JSON.stringify([nodes, edges]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g = useMemo(() => layout(nodes, edges), [key]);
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
            const ed = g.edge(e);
            return (
              <g key={i}>
                <path className="edge" d={smooth(ed.points)} markerEnd={"url(#" + mk + ")"} strokeDasharray={e.w.startsWith("fu:") ? "5 4" : undefined} />
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
