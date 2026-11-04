import { GRID, OUTCOLOR, V3, V3_HASH } from "../domain/data";
import { classify, describeP, golden } from "../domain/logic";
import type { Model, OutKey, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { XlsCompare } from "../components/XlsCompare";

function ClsTag({ o, m }: { o: OutKey | "none"; m: Model }) {
  if (o === "none") return <span className="note">out of range</span>;
  return <span className="cls"><i style={{ background: "var(--" + OUTCOLOR[o] + ")" }} />{m[o].title}</span>;
}

/** Release = Verify (synthetic patients) + Changes (IT deploy approval). */
export function ReleaseScreen({ w, role, act }: { w: Workflow | null; role: Role; act: Actions }) {
  if (!w || !w.approved || !["verify", "deploy", "done"].includes(w.state))
    return <div className="banner">Release opens after the clinician approves. Then every synthetic patient runs through the new form, and the IT approver deploys it.</div>;
  const m = w.model, v = w.verify, a = w.approved;
  const tile = (k: string, x: string | number, c = "") => <div key={k} className={"chk " + c}><span className="k">{k}</span><span className="v">{x}</span></div>;

  return (
    <>
      <div className="top">
        <div>
          <h1>Release {a.ver}</h1>
          <div className="ver">{"v3 " + V3_HASH + " → " + a.ver + " " + a.hash + " · built from the approved hash only"}</div>
        </div>
        {w.state === "verify" ? <button type="button" className="btn primary" onClick={act.runVerify}>Run synthetic check</button>
          : w.state === "deploy" ? <button type="button" className="btn primary" disabled={role !== "it"} onClick={act.approveDeploy}>Approve deploy</button>
          : <span className="st ok">Deployed</span>}
      </div>
      {w.state === "deploy" && role !== "it" ? <div className="note">Only the IT approver can approve the deploy. The clinician approved the content, so they can't also deploy it.</div> : null}

      {!v ? (
        <div className="banner">The system builds the form with cht-conf, then runs every synthetic patient through (a) the approved rules in code and (b) the filled form in cht-conf-test-harness. Any mismatch returns the change to the program officer.</div>
      ) : (
        <>
          <div className="checks">
            {tile("Content approval", "Clinician · round " + a.round)}
            {tile("Rules vs form", v.match + " / " + v.total + " match", v.match === v.total ? "" : "bad")}
            {tile("Branch coverage", v.cov + " of 4 rules")}
            {tile("Golden cases", golden(m).filter(g => g.ok).length + " of 12")}
            {tile("Mutation test", v.mut + " patients caught")}
            {tile("Rollback", "Redeploy v3", "muted")}
          </div>
          <section className="panel">
            <div className="ph"><h2>Synthetic patients</h2><span className="ver">Sample of 12 · expected outcomes come from the approved rules in code</span></div>
            <div className="tw">
              <table>
                <thead><tr>{["Patient", "Inputs", "Expected (rules)", "Actual (form)", "Match"].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
                <tbody>
                  {GRID.filter((_p, i) => i % 23 === 0).slice(0, 12).map(p => {
                    const e = classify(m, p).out;
                    return (
                      <tr key={p.id}>
                        <td className="mono">{p.id}</td>
                        <td>{p.age + " mo, " + p.rr + "/min, " + describeP(p)}</td>
                        <td><ClsTag o={e} m={m} /></td>
                        <td><ClsTag o={e} m={m} /></td>
                        <td className="okc">{"✓"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ margin: 0 }}>Simulated: the "Actual (form)" column will come from cht-conf-test-harness once the backend runs it.</p>
          </section>
          <XlsCompare a={V3} b={m} la="v3" lb={a.ver} />
        </>
      )}
    </>
  );
}
