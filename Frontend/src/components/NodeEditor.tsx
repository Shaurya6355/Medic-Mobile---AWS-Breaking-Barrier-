import { COND, SIGNS, QTYPE, V3, clone } from "../domain/data";
import { anyQ, facts, isNode, qStatus, usesOf } from "../domain/logic";
import type { ItemId, Model, NodeId, Patch } from "../domain/types";
import { CommitInput, CommitTextarea, Field } from "./inputs";

export type EditFn = (item: ItemId, field: string, patch: Patch) => void;

/** Read-only facts, with the live v3 value struck through where it differs. */
export function Facts({ m, id }: { m: Model; id: ItemId }) {
  const now = facts(m, id), was = facts(V3, id);
  return (
    <dl className="facts">
      {now.map(([k, v], i) => {
        const old = was.find(f => f[0] === k)?.[1];
        return (
          <div key={i} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}{old !== undefined && old !== v ? <span className="was">v3: <del>{old}</del></span> : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function QuestionsRead({ m, id, edit }: { m: Model; id: ItemId; edit?: EditFn }) {
  const qs = usesOf(m, id);
  if (!qs.length) return null;
  return (
    <div className="qread">
      <div className="lab">Questions this step asks</div>
      {qs.map(q => {
        const x = m.questions[q], st = qStatus(m, q);
        return (
          <div key={q} className="qrow">
            <div className="qtop">
              <span className="mono">{q + " · " + QTYPE[x.type]}</span>
              {st !== "same" ? <span className={"badge q-" + st}>{st[0].toUpperCase() + st.slice(1)}</span> : null}
            </div>
            {edit ? (
              <div className="qedit">
                <label className="sr" htmlFor={"ql-" + q}>Label for {q}</label>
                <CommitInput id={"ql-" + q} type="text" value={x.label} onCommit={v => edit(id, "ql-" + q, { op: "setQ", q, key: "label", value: v })} />
                <label className="sr" htmlFor={"qs-" + q}>Shown when for {q}</label>
                <CommitInput id={"qs-" + q} type="text" className="mono" placeholder="always" value={x.showIf} onCommit={v => edit(id, "qs-" + q, { op: "setQ", q, key: "showIf", value: v })} />
              </div>
            ) : (
              <div><b>{x.label}</b><span className="note">{" · shown when " + (x.showIf || "always")}</span></div>
            )}
            {st === "changed" ? <span className="was">v3: <del>{V3.questions[q].label}</del></span> : null}
          </div>
        );
      })}
    </div>
  );
}

function QuestionEditor({ m, id, edit }: { m: Model; id: ItemId; edit: EditFn }) {
  const q = id.slice(2), x = m.questions[q];
  if (!x) {
    const orig = anyQ(q);
    return (
      <div className="stack">
        <Facts m={m} id={id} />
        <p className="note">{V3.questions[q] ? "Removed in v4: the 2014 source no longer cites it." : "Removed from this draft."}</p>
        {orig ? <button type="button" className="btn tiny" onClick={() => edit(id, "restore", { op: "addQ", q, question: clone(orig) })}>Restore question</button> : null}
      </div>
    );
  }
  return (
    <div className="stack">
      <Field id="f-ql" label="Question label">
        <CommitInput id="f-ql" type="text" value={x.label} onCommit={v => edit(id, "label", { op: "setQ", q, key: "label", value: v })} />
      </Field>
      <Field id="f-qs" label="Shown when" help="For example: cough = yes">
        <CommitInput id="f-qs" type="text" className="mono" value={x.showIf} onCommit={v => edit(id, "show", { op: "setQ", q, key: "showIf", value: v })} />
      </Field>
      <div className="note">Type: {QTYPE[x.type]}</div>
      <button type="button" className="btn tiny bad" onClick={() => edit(id, "remove", { op: "removeQ", q })}>Remove question</button>
    </div>
  );
}

export function NodeEditor({ m, id, edit }: { m: Model; id: ItemId; edit: EditFn }) {
  if (id.startsWith("q:")) return <QuestionEditor m={m} id={id} edit={edit} />;
  if (!isNode(id)) return null;
  const node: NodeId = id;
  const v = m[node] as unknown as Record<string, string | number | string[]>;
  const set = (k: string, value: string | number | string[]) => edit(node, k, { op: "set", node, key: k, value });

  const num = (k: string, label: string) => (
    <Field key={k} id={"f-" + k} label={label}>
      <CommitInput id={"f-" + k} type="number" value={v[k] as number} onCommit={s => set(k, Number(s))} />
    </Field>
  );
  const txt = (k: string, label: string) => (
    <Field key={k} id={"f-" + k} label={label}>
      <CommitInput id={"f-" + k} type="text" value={v[k] as string} onCommit={s => set(k, s)} />
    </Field>
  );
  const area = (k: string, label: string, help?: string) => (
    <Field key={k} id={"f-" + k} label={label} help={help}>
      <CommitTextarea id={"f-" + k} rows={3} value={v[k] as string} onCommit={s => set(k, s)} />
    </Field>
  );
  const toggles = (k: string, opts: Record<string, string>, label: string) => {
    const cur = v[k] as string[];
    return (
      <fieldset key={k} className="fld">
        <legend>{label}</legend>
        <div className="tgl">
          {Object.keys(opts).map(o => (
            <label key={o} className={"tg" + (cur.includes(o) ? " on" : "")}>
              <input type="checkbox" checked={cur.includes(o)} onChange={() => set(k, cur.includes(o) ? cur.filter(x => x !== o) : cur.concat(o))} />
              {opts[o]}
            </label>
          ))}
        </div>
      </fieldset>
    );
  };

  let body;
  switch (node) {
    case "start": body = [num("ageMin", "Youngest age (months)"), num("ageMax", "Up to age (months, not included)")]; break;
    case "d1": body = [txt("q", "Question"), toggles("signs", SIGNS, "Values: yes if any of these")]; break;
    case "d2": body = [txt("q", "Question"), toggles("conds", COND, "Values: yes if any of these"), area("hint", "Note shown under the question")]; break;
    case "d3": body = [txt("q", "Question"), toggles("conds", COND, "Values: yes if any of these"),
      m.d3.conds.includes("fast") ? (
        <fieldset key="fb" className="fld"><legend>Fast breathing thresholds</legend>
          <div className="row3">{num("cut", "Age cut-off (months)")}{num("young", "Under it (/min)")}{num("old", "At or over it (/min)")}</div>
        </fieldset>
      ) : null,
      area("hint", "Note shown under the question")]; break;
    case "f1": body = [txt("title", "Task title"), <div key="r" className="row3">{num("due", "Due on day")}{num("end", "Open until day")}</div>]; break;
    default: body = [txt("title", "Classification name"), area("note", "Note shown to the CHW", "Clinical text: the clinician sees every change.")];
  }
  return <div className="stack">{body}<QuestionsRead m={m} id={id} edit={edit} /></div>;
}
