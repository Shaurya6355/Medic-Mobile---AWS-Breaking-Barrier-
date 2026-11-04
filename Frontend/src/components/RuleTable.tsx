import { item, print, type Rule } from "../../../shared/pathway/index.ts";
import { sevColor } from "../domain/data";
import { getO, rowIssues } from "../domain/logic";
import type { Check, ItemId, Model, Workflow } from "../domain/types";
import type { Markers } from "./Flow";
import type { EditFn } from "./NodeEditor";
import { CommitInput, CondInput } from "./inputs";

const STATUS = { edit: ["Edit required", "bad"], check: ["Check", "warn"], ok: ["OK", "good"] } as const;

function Issues({ checks, flags }: ReturnType<typeof rowIssues>) {
  if (!checks.length && !flags.length) return null;
  return (
    <ul className="rissues">
      {checks.map((c, i) => <li key={i} className={c.sev}>{c.text}</li>)}
      {flags.map(f => <li key={f.id} className="flag">{"Flag " + f.id.slice(2) + (f.clinical ? " (clinician): " : " (you): ") + f.title}</li>)}
    </ul>
  );
}

function Status({ s }: { s: keyof typeof STATUS }) {
  return <span className={"rstat " + STATUS[s][1]}>{STATUS[s][0]}</span>;
}

/** Rules in priority order: the IR as an editable table. The decision flow is drawn from this same data. */
export function RuleTable({ w, canEdit, checks, sel, onSelect, edit, markers }: {
  w: Workflow; canEdit: boolean; checks: Check[]; sel: string; onSelect: (id: ItemId) => void; edit: EditFn; markers: Markers;
}) {
  const m: Model = w.model;
  const rules = m.rules.slice().sort((a, b) => a.priority - b.priority);
  const setRules = (field: string, next: Rule[]) => edit("rules", field, { op: "set", path: ["rules"], value: next.map((r, i) => ({ ...r, priority: i + 1 })) });
  const move = (i: number, d: -1 | 1) => { const x = rules.slice(); [x[i], x[i + d]] = [x[i + d], x[i]]; setRules("order", x); };
  const remove = (i: number) => setRules("remove " + rules[i].id, rules.filter((_, k) => k !== i));
  const add = () => {
    const n = Math.max(0, ...m.rules.map(r => Number(r.id.replace(/\D/g, "")) || 0)) + 1;
    const firstYes = m.questions.find(q => q.answer_type === "yes_no")?.id ?? m.derived[0]?.id ?? "cough";
    const at = rules.findIndex(r => r.when === "otherwise");
    const x = rules.slice();
    x.splice(at < 0 ? x.length : at, 0, { id: "R" + n, priority: 0, when: { field: firstYes, op: "is_yes" }, outcome: m.outcomes[0].id, origin: "team" });
    setRules("add R" + n, x);
  };
  const counts = rules.map(r => rowIssues(checks, w.flags, [item.rule(r.id), item.out(r.outcome), item.fu(r.outcome)]).status);

  return (
    <div className="rtablewrap">
      <div className="rsummary">
        <span><Status s="edit" /> {counts.filter(c => c === "edit").length}</span>
        <span><Status s="check" /> {counts.filter(c => c === "check").length}</span>
        <span><Status s="ok" /> {counts.filter(c => c === "ok").length}</span>
        <span className="note">First matching rule wins. {canEdit ? "Edits save as you type and redraw the flow." : "Read-only for your role."}</span>
      </div>
      <div className="tw">
        <table className="rtable">
          <thead><tr>{["#", "Rule", "If", "Then", "Follow-up", "Source", "Status"].map(t => <th key={t}>{t}</th>)}{canEdit ? <th /> : null}</tr></thead>
          <tbody>
            {rules.map((r, i) => {
              const id = item.rule(r.id), o = getO(m, r.outcome), fu = o?.follow_up;
              const iss = rowIssues(checks, w.flags, [id, item.out(r.outcome), item.fu(r.outcome)]);
              const other = r.when === "otherwise";
              const last = i === rules.length - 1, beforeOther = rules[i + 1]?.when === "otherwise";
              return (
                <tr key={r.id} className={"r-" + iss.status + (sel === id ? " sel" : "")} onClick={() => onSelect(id)}>
                  <td className="mono">
                    {r.priority}
                    {canEdit && !other ? (
                      <span className="rmove" onClick={e => e.stopPropagation()}>
                        <button type="button" className="lnk" aria-label={"Move " + r.id + " up"} disabled={i === 0} onClick={() => move(i, -1)}>{"▲"}</button>
                        <button type="button" className="lnk" aria-label={"Move " + r.id + " down"} disabled={last || beforeOther} onClick={() => move(i, 1)}>{"▼"}</button>
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <b className="mono">{r.id}</b>
                    <span className="badges">{(markers[id] || []).map((b, k) => <span key={k} className={"badge " + b[0]}>{b[1]}</span>)}</span>
                    <span className="note">{r.origin}</span>
                  </td>
                  <td className="rcond" onClick={e => canEdit && e.stopPropagation()}>
                    {other ? <i className="note">otherwise (no earlier rule matched)</i>
                      : canEdit ? <CondInput id={"rw-" + r.id} live value={r.when as Exclude<Rule["when"], "otherwise">}
                          onCommit={c => c && edit(id, "when", { op: "set", path: ["rules", r.id, "when"], value: c })} />
                      : <span className="mono">{print(r.when as Exclude<Rule["when"], "otherwise">)}</span>}
                  </td>
                  <td onClick={e => canEdit && e.stopPropagation()}>
                    <span className="cls"><i style={{ background: "var(--" + sevColor(o?.severity ?? 5) + ")" }} />
                      {canEdit ? (
                        <select aria-label={"Outcome for " + r.id} value={r.outcome} onChange={e => edit(id, "outcome", { op: "set", path: ["rules", r.id, "outcome"], value: e.target.value })}>
                          {m.outcomes.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
                        </select>
                      ) : o?.title ?? r.outcome}
                    </span>
                  </td>
                  <td onClick={e => canEdit && e.stopPropagation()}>
                    {!fu ? <span className="note">none</span> : (
                      <span className="rfu">
                        <span className="note">{fu.kind === "scheduled" ? "visit, day" : "on return, day"}</span>
                        {canEdit ? <CommitInput type="number" live aria-label={"Follow-up due day for " + r.outcome} value={fu.due_in_days ?? ""}
                          onCommit={v => edit(item.fu(r.outcome), "due", { op: "set", path: ["outcomes", r.outcome, "follow_up", "due_in_days"], value: v.trim() === "" ? null : Number(v) })} />
                          : <b>{fu.due_in_days ?? "-"}</b>}
                      </span>
                    )}
                  </td>
                  <td className="rsrc">{r.source ? <><b>{"p. " + r.source.page}</b> {"“" + r.source.quote + "”"}</> : <span className="note">team, no quote</span>}</td>
                  <td><Status s={iss.status} /><Issues {...iss} /></td>
                  {canEdit ? (
                    <td onClick={e => e.stopPropagation()}>
                      {!other ? <button type="button" className="btn tiny bad" aria-label={"Delete " + r.id} onClick={() => remove(i)}>{"×"}</button> : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit ? <div className="btnrow"><button type="button" className="btn tiny" onClick={add}>+ Add rule</button><span className="note">New rules go just before "otherwise".</span></div> : null}

      <div className="lab" style={{ marginTop: 14 }}>Derived values (the rules read these)</div>
      <div className="tw">
        <table className="rtable">
          <thead><tr>{["Value", "Name", "Yes when", "Source", "Status"].map(t => <th key={t}>{t}</th>)}</tr></thead>
          <tbody>
            {m.derived.map(d => {
              const id = item.d(d.id), iss = rowIssues(checks, w.flags, [id]);
              return (
                <tr key={d.id} className={"r-" + iss.status + (sel === id ? " sel" : "")} onClick={() => onSelect(id)}>
                  <td><b className="mono">{d.id}</b><span className="badges">{(markers[id] || []).map((b, k) => <span key={k} className={"badge " + b[0]}>{b[1]}</span>)}</span></td>
                  <td onClick={e => canEdit && e.stopPropagation()}>{canEdit ? <CommitInput type="text" live aria-label={"Name of " + d.id} value={d.label} onCommit={v => edit(id, "label", { op: "set", path: ["derived", d.id, "label"], value: v })} /> : d.label}</td>
                  <td className="rcond" onClick={e => canEdit && e.stopPropagation()}>
                    {canEdit ? <CondInput id={"dw-" + d.id} live value={d.definition} onCommit={c => c && edit(id, "def", { op: "set", path: ["derived", d.id, "definition"], value: c })} />
                      : <span className="mono">{print(d.definition)}</span>}
                  </td>
                  <td className="rsrc">{d.source ? <><b>{"p. " + d.source.page}</b> {"“" + d.source.quote + "”"}</> : <span className="note">team, no quote</span>}</td>
                  <td><Status s={iss.status} /><Issues {...iss} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
