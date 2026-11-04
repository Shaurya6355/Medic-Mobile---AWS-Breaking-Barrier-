import { useEffect, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/** Text inputs commit on Enter or when you leave the field (SPEC, merging notes). */
type InProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string | number; onCommit: (v: string) => void };
export function CommitInput({ value, onCommit, ...rest }: InProps) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => { if (v !== String(value)) onCommit(v); };
  return <input {...rest} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); }} />;
}

type TaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onCommit: (v: string) => void };
export function CommitTextarea({ value, onCommit, ...rest }: TaProps) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <textarea {...rest} value={v} onChange={e => setV(e.target.value)} onBlur={() => { if (v !== value) onCommit(v); }} />;
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
