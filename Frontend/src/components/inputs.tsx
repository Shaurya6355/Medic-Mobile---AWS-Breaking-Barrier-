import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { parse, print, type Cond } from "../../../shared/pathway/index.ts";

/** Commit after the user pauses typing (live mode), or on Enter / leaving the field.
    While the field has focus, outside updates don't overwrite what is being typed. */
function useCommit(value: string, onCommit: (v: string) => void, live?: boolean) {
  const [v, setV] = useState(value);
  const focused = useRef(false), timer = useRef<number | undefined>(undefined), last = useRef(value);
  useEffect(() => { last.current = value; if (!focused.current) setV(value); }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const commit = (x: string) => { window.clearTimeout(timer.current); if (x !== last.current) { last.current = x; onCommit(x); } };
  return {
    v,
    change: (x: string) => { setV(x); if (live) { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => commit(x), 400); } },
    focus: () => { focused.current = true; },
    blur: () => { focused.current = false; commit(v); },
    commit: () => commit(v),
  };
}

/** Text inputs commit on Enter or when you leave the field; with `live`, also after a short pause. */
type InProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string | number; onCommit: (v: string) => void; live?: boolean };
export function CommitInput({ value, onCommit, live, ...rest }: InProps) {
  const c = useCommit(String(value), onCommit, live);
  return <input {...rest} value={c.v} onChange={e => c.change(e.target.value)} onFocus={c.focus} onBlur={c.blur} onKeyDown={e => { if (e.key === "Enter") c.commit(); }} />;
}

type TaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onCommit: (v: string) => void; live?: boolean };
export function CommitTextarea({ value, onCommit, live, ...rest }: TaProps) {
  const c = useCommit(value, onCommit, live);
  return <textarea {...rest} value={c.v} onChange={e => c.change(e.target.value)} onFocus={c.focus} onBlur={c.blur} />;
}

/** A condition in its text form. Parsed as you type; only a condition that parses is saved, otherwise the error shows. */
export function CondInput({ id, value, optional, live, onCommit }: { id: string; value: Cond | undefined; optional?: boolean; live?: boolean; onCommit: (c: Cond | null) => void }) {
  const text = value ? print(value) : "";
  const [err, setErr] = useState<string | null>(null);
  const save = (s: string) => {
    if (!s.trim()) { if (optional) { setErr(null); onCommit(null); } else setErr("A condition is required."); return; }
    try { const c = parse(s); setErr(null); if (print(c) !== text) onCommit(c); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const c = useCommit(text, save, live);
  useEffect(() => { setErr(null); }, [text]);
  return (
    <>
      <textarea id={id} className="mono" rows={Math.min(5, 1 + Math.ceil(c.v.length / 48))} value={c.v} placeholder={optional ? "always" : ""}
        aria-invalid={!!err} onChange={e => c.change(e.target.value)} onFocus={c.focus} onBlur={c.blur}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); c.commit(); } }} />
      {err ? <span className="note badc" role="alert">{err}</span> : null}
    </>
  );
}

export function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      {children}
      {help ? <span className="note">{help}</span> : null}
    </div>
  );
}
