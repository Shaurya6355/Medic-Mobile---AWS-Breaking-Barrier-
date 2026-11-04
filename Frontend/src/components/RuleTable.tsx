import { item, print, srcList, type Rule, type Sources } from "../../../shared/pathway/index.ts";
import { sevColor } from "../domain/data";
import { getO, rowIssues } from "../domain/logic";
import type { Check, ItemId, Model, Workflow } from "../domain/types";
import type { Markers } from "./Flow";
import type { EditFn } from "./NodeEditor";
import { CommitInput, CondInput } from "./inputs";
import { IssueLine } from "./Checks";

const STATUS = { edit: ["Edit required", "bad"], check: ["Check", "warn"], ok: ["OK", "good"] } as const;

function Issues({ checks, flags }: ReturnType<typeof rowIssues>) {
  return (
    <ul className="rissues">
      {checks.map((c, i) => <IssueLine key={i} c={c} />)}
      {flags.map(f => <li key={f.id} className="flag"><b>{"Flag " + f.id.slice(2)}</b>{(f.clinical ? "Clinician decides: " : "You decide: ") + f.title}</li>)}
    </ul>
  );
}

function Status({ s, n }: { s: keyof typeof STATUS; n?: number }) {
  return <span className={"rstat " + STATUS[s][1]}>{STATUS[s][0]}{n ? " · " + n : ""}</span>;
}

function Src({ s }: { s?: Sources }) {
  const l = srcList(s);
  return l.length ? <span className="rsrc" title={l.map(x => "p. " + x.page + ": “" + x.quote + "”").join("\n")}>{"p. " + [...new Set(l.map(x => x.page))].join(", ")}</span> : <span className="rsrc team">no quote</span>;
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
          <colgroup><col style={{ width: 52 }} /><col style={{ width: 118 }} /><col /><col style={{ width: 230 }} /><col style={{ width: 118 }} /><col style={{ width: 128 }} />{canEdit ? <col style={{ width: 44 }} /> : null}</colgroup>
          <thead><tr>{["#", "Rule", "If", "Then", "Follow-up", "Status"].map(t => <th key={t}>{t}</th>)}{canEdit ? <th /> : null}</tr></thead>
          {rules.map((r, i) => {
            const id = item.rule(r.id), o = getO(m, r.outcome), fu = o?.follow_up;
            const iss = rowIssues(checks, w.flags, [id, item.out(r.outcome), item.fu(r.outcome)]);
            const n = iss.checks.length + iss.flags.length;
            const other = r.when === "otherwise";
            const last = i === rules.length - 1, beforeOther = rules[i + 1]?.when === "otherwise";
            const stop = (e: React.MouseEvent) => { if (canEdit) e.stopPropagation(); };
            return (
              <tbody key={r.id} className={"r-" + iss.status + (sel === id ? " sel" : "")} onClick={() => onSelect(id)}>
                <tr>
                  <td className="rnum">
                    <span className="mono">{r.priority}</span>
                    {canEdit && !other ? (
                      <span className="rmove" onClick={e => e.stopPropagation()}>
                        <button type="button" className="lnk" aria-label={"Move " + r.id + " up"} disabled={i === 0} onClick={() => move(i, -1)}>{"▲"}</button>
                        <button type="button" className="lnk" aria-label={"Move " + r.id + " down"} disabled={last || beforeOther} onClick={() => move(i, 1)}>{"▼"}</button>
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <div className="rid"><b className="mono">{r.id}</b><Src s={r.source} /></div>
                    <div className="rmeta">{r.origin === "team" ? "team rule" : "from guideline"}</div>
                    <span className="badges">{(markers[id] || []).map((b, k) => <span key={k} className={"badge " + b[0]}>{b[1]}</span>)}</span>
                  </td>
                  <td className="rcond" onClick={stop}>
                    {other ? <i className="note">otherwise: no earlier rule matched</i>
                      : canEdit ? <CondInput id={"rw-" + r.id} live value={r.when as Exclude<Rule["when"], "otherwise">}
                          onCommit={c => c && edit(id, "when", { op: "set", path: ["rules", r.id, "when"], value: c })} />
                      : <span className="mono">{print(r.when as Exclude<Rule["when"], "otherwise">)}</span>}
                  </td>
                  <td onClick={stop}>
                    <span className="rthen"><i style={{ background: "var(--" + sevColor(o?.severity ?? 5) + ")" }} />
                      {canEdit ? (
                        <select aria-label={"Outcome for " + r.id} value={r.outcome} onChange={e => edit(id, "outcome", { op: "set", path: ["rules", r.id, "outcome"], value: e.target.value })}>
                          {m.outcomes.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
                        </select>
                      ) : <span>{o?.title ?? r.outcome}</span>}
                    </span>
                  </td>
                  <td onClick={stop}>
                    {!fu ? <span className="note">none</span> : (
                      <div className="rfu">
                        <span className="rmeta">{fu.kind === "scheduled" ? "visit on day" : "on return, day"}</span>
                        {canEdit ? <CommitInput type="number" live aria-label={"Follow-up due day for " + r.outcome} value={fu.due_in_days ?? ""} placeholder="-"
                          onCommit={v => edit(item.fu(r.outcome), "due", { op: "set", path: ["outcomes", r.outcome, "follow_up", "due_in_days"], value: v.trim() === "" ? null : Number(v) })} />
                          : <b>{fu.due_in_days ?? "-"}</b>}
                      </div>
                    )}
                  </td>
                  <td><Status s={iss.status} n={n} /></td>
                  {canEdit ? (
                    <td onClick={e => e.stopPropagation()}>
                      {!other ? <button type="button" className="rdel" aria-label={"Delete " + r.id} title={"Delete " + r.id} onClick={() => remove(i)}>{"×"}</button> : null}
                    </td>
                  ) : null}
                </tr>
                {n ? <tr className="rdetail"><td /><td colSpan={canEdit ? 6 : 5}><Issues {...iss} /></td></tr> : null}
              </tbody>
            );
          })}
        </table>
      </div>
      {canEdit ? <div className="btnrow"><button type="button" className="btn tiny" onClick={add}>+ Add rule</button><span className="note">New rules go just before "otherwise". Hover a page number to read the quote.</span></div> : null}

      <h3 className="rsec">Derived values <span className="note">computed from the answers; the rules read these</span></h3>
      <div className="tw">
        <table className="rtable">
          <colgroup><col style={{ width: 170 }} /><col style={{ width: 200 }} /><col /><col style={{ width: 128 }} /></colgroup>
          <thead><tr>{["Value", "Name", "Yes when", "Status"].map(t => <th key={t}>{t}</th>)}</tr></thead>
          {m.derived.map(d => {
            const id = item.d(d.id), iss = rowIssues(checks, w.flags, [id]), n = iss.checks.length + iss.flags.length;
            const stop = (e: React.MouseEvent) => { if (canEdit) e.stopPropagation(); };
            return (
              <tbody key={d.id} className={"r-" + iss.status + (sel === id ? " sel" : "")} onClick={() => onSelect(id)}>
                <tr>
                  <td>
                    <div className="rid"><b className="mono">{d.id}</b><Src s={d.source} /></div>
                    <span className="badges">{(markers[id] || []).map((b, k) => <span key={k} className={"badge " + b[0]}>{b[1]}</span>)}</span>
                  </td>
                  <td onClick={stop}>{canEdit ? <CommitInput type="text" live aria-label={"Name of " + d.id} value={d.label} onCommit={v => edit(id, "label", { op: "set", path: ["derived", d.id, "label"], value: v })} /> : d.label}</td>
                  <td className="rcond" onClick={stop}>
                    {canEdit ? <CondInput id={"dw-" + d.id} live value={d.definition} onCommit={c => c && edit(id, "def", { op: "set", path: ["derived", d.id, "definition"], value: c })} />
                      : <span className="mono">{print(d.definition)}</span>}
                  </td>
                  <td><Status s={iss.status} n={n} /></td>
                </tr>
                {n ? <tr className="rdetail"><td colSpan={4}><Issues {...iss} /></td></tr> : null}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
