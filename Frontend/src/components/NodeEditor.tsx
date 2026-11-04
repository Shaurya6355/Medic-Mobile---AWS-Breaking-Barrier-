import { print, splitItem, type Cond } from "../../../shared/pathway/index.ts";
import { V3, clone } from "../domain/data";
import { anyQ, facts, getQ, qStatus, slots, usesOf, type Slot } from "../domain/logic";
import type { ItemId, Model, Patch } from "../domain/types";
import { CommitInput, CommitTextarea, CondInput, Field } from "./inputs";

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
            <dd className={k === "If" || k === "Yes when" || k === "Shown when" ? "mono" : undefined}>{v}{old !== undefined && old !== v ? <span className="was">v3: <del>{old}</del></span> : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function SlotField({ m, id, s, edit }: { m: Model; id: ItemId; s: Slot; edit: EditFn }) {
  const fid = "f-" + s.key;
  const set = (value: unknown) => edit(id, s.key, { op: "set", path: s.path, value });
  switch (s.kind) {
    case "text": return <Field id={fid} label={s.label} help={s.help}><CommitInput id={fid} type="text" value={String(s.value ?? "")} onCommit={set} /></Field>;
    case "area": return <Field id={fid} label={s.label} help={s.help}><CommitTextarea id={fid} rows={3} value={String(s.value ?? "")} onCommit={set} /></Field>;
    case "number": return <Field id={fid} label={s.label} help={s.help}><CommitInput id={fid} type="number" value={s.value === undefined ? "" : String(s.value)} onCommit={v => { if (v.trim() !== "" && !isNaN(Number(v))) set(Number(v)); }} /></Field>;
    case "numberOrNull": return <Field id={fid} label={s.label} help={s.help ?? "Empty = not set"}><CommitInput id={fid} type="number" value={s.value === null ? "" : String(s.value)} onCommit={v => set(v.trim() === "" ? null : Number(v))} /></Field>;
    case "outcome": return (
      <Field id={fid} label={s.label}>
        <select id={fid} value={String(s.value)} onChange={e => set(e.target.value)}>
          {m.outcomes.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </Field>
    );
    case "cond": return (
      <Field id={fid} label={s.label} help={s.help}>
        <CondInput id={fid} value={s.value as Cond | undefined} optional={s.optional} onCommit={c => (c ? set(c) : edit(id, s.key, { op: "unset", path: s.path }))} />
      </Field>
    );
  }
}

export function QuestionsRead({ m, id, edit }: { m: Model; id: ItemId; edit?: EditFn }) {
  const qs = usesOf(m, id);
  if (!qs.length) return null;
  return (
    <div className="qread">
      <div className="lab">Questions this step reads</div>
      {qs.map(q => {
        const x = getQ(m, q)!, st = qStatus(m, q);
        return (
          <div key={q} className="qrow">
            <div className="qtop">
              <span className="mono">{q + " · " + (x.answer_type === "yes_no" ? "yes/no" : "integer")}</span>
              {st !== "same" ? <span className={"badge q-" + st}>{st[0].toUpperCase() + st.slice(1)}</span> : null}
            </div>
            {edit ? (
              <div className="qedit">
                <label className="sr" htmlFor={"ql-" + q}>Label for {q}</label>
                <CommitInput id={"ql-" + q} type="text" value={x.label} onCommit={v => edit(id, "ql-" + q, { op: "set", path: ["questions", q, "label"], value: v })} />
                <label className="sr" htmlFor={"qs-" + q}>Shown when for {q}</label>
                <CondInput id={"qs-" + q} value={x.shown_when} optional
                  onCommit={c => edit(id, "qs-" + q, c ? { op: "set", path: ["questions", q, "shown_when"], value: c } : { op: "unset", path: ["questions", q, "shown_when"] })} />
              </div>
            ) : (
              <div><b>{x.label}</b><span className="note">{" · shown when " + (x.shown_when ? print(x.shown_when) : "always")}</span></div>
            )}
            {st === "changed" && getQ(V3, q)!.label !== x.label ? <span className="was">v3: <del>{getQ(V3, q)!.label}</del></span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function NodeEditor({ m, id, edit }: { m: Model; id: ItemId; edit: EditFn }) {
  const [k, key] = splitItem(id);
  if (k === "q" && !getQ(m, key)) {
    const orig = anyQ(key);
    return (
      <div className="stack">
        <Facts m={m} id={id} />
        <p className="note">{getQ(V3, key) ? "Removed in v4: not in the drafted logic model." : "Removed from this draft."}</p>
        {orig ? <button type="button" className="btn tiny" onClick={() => edit(id, "restore", { op: "addQ", question: clone(orig) })}>Restore question</button> : null}
      </div>
    );
  }
  const sl = slots(m, id);
  const rule = k === "rule" ? m.rules.find(r => r.id === key) : null;
  return (
    <div className="stack">
      {rule ? <div className="note">{"Priority " + rule.priority + (rule.when === "otherwise" ? " · Otherwise: matches when no earlier rule did." : " · tried after every rule with a lower priority.")}</div> : null}
      {sl.map(s => <SlotField key={s.key} m={m} id={id} s={s} edit={edit} />)}
      {k === "q" ? (
        <>
          <div className="note">Type: {getQ(m, key)!.answer_type === "yes_no" ? "yes/no" : "integer"}</div>
          <button type="button" className="btn tiny bad" onClick={() => edit(id, "remove", { op: "removeQ", q: key })}>Remove question</button>
        </>
      ) : null}
      <QuestionsRead m={m} id={id} edit={edit} />
    </div>
  );
}
