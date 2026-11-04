import { item } from "../../../shared/pathway/index.ts";
import { sevColor } from "../domain/data";
import { getO, golden } from "../domain/logic";
import type { Answers, Model } from "../domain/types";

/** A test patient in plain words: "8-month-old · 52 breaths a minute · convulsions". */
function who(m: Model, a: Answers): string {
  const parts: string[] = [];
  const age = a.age_months;
  if (typeof age === "number") parts.push(age >= 24 && age % 12 === 0 ? age / 12 + "-year-old" : age + "-month-old");
  m.questions.slice().sort((x, y) => x.order - y.order).forEach(q => {
    const v = a[q.id];
    if (q.id === "age_months" || v === undefined || v === null || v === false) return;
    if (q.unit === "breaths_per_minute") parts.push(v + " breaths a minute");
    else if (q.unit === "days") parts.push("cough for " + v + " days");
    else if (typeof v === "number") parts.push(q.id.replace(/_/g, " ") + " " + v);
    else parts.push(q.id.replace(/_/g, " "));
  });
  return parts.join(" · ") || "No signs";
}

/** Golden cases for a non-technical reader: who the patient is, what they should get, whether they do. */
export function GoldenCases({ m, onSelect }: { m: Model; onSelect: (id: string) => void }) {
  const g = golden(m), ok = g.filter(x => x.ok).length;
  if (!g.length) return <p className="note">No test patients for this pathway yet.</p>;
  return (
    <section className="golden" aria-label="Test patients">
      <div className="gh">
        <h2>Test patients</h2>
        <span className={"gscore " + (ok === g.length ? "ok" : "bad")}>{ok + " of " + g.length + " get the expected result"}</span>
      </div>
      <ul className="glist">
        {g.map(x => {
          const o = getO(m, x.exp), got = x.got ? getO(m, x.got) : null;
          return (
            <li key={x.id}>
              <button type="button" className={"gcard " + (x.ok ? "ok" : "bad")} onClick={() => x.rule && onSelect(item.rule(x.rule))} title={"Show rule " + (x.rule ?? "") + " on the flow"}>
                <span className="gmark" aria-label={x.ok ? "matches" : "does not match"}>{x.ok ? "✓" : "✗"}</span>
                <span className="gwho">{who(m, x.a)}</span>
                <span className="gout"><i style={{ background: "var(--" + sevColor(o?.severity ?? 5) + ")" }} />{o?.title ?? x.exp}</span>
                {!x.ok ? <span className="ggot">{"Gets instead: " + (got?.title ?? "no classification")}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
