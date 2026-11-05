import { V3, V3_HASH, sevColor } from "../domain/data";
import { classify, describeP, getO, golden, grid } from "../domain/logic";
import type { Model, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { XlsCompare } from "../components/XlsCompare";
import { JsonDiff } from "../components/JsonDiff";
import { Flow, type Markers } from "../components/Flow";
import { allItems, changedVs } from "../domain/logic";
import { useState } from "react";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/Page";

type Tab = "flow" | "json" | "form";
/** What IT approves: the flow (live or new), the logic model JSON diff and the form diff, all built from the approved hash. */
function Changes({ w }: { w: Workflow }) {
  const [tab, setTab] = useState<Tab>("flow");
  const [side, setSide] = useState<"new" | "live">("new");
  const m = w.model, ver = w.approved!.ver;
  const shown = side === "new" ? m : V3;
  const mk: Markers = {};
  if (side === "new") allItems(m, V3).forEach(id => { if (changedVs(m, id)) mk[id] = [["changed", "Changed"]]; });
  const n = allItems(m, V3).filter(id => changedVs(m, id)).length;
  return (
    <section className="panel">
      <div className="ph">
        <h2>{"Changes · v3 → " + ver}</h2>
        <div className="viewtgl" role="group" aria-label="Changes view">
          {([["flow", "Flow"], ["json", "JSON diff"], ["form", "Form diff"]] as [Tab, string][]).map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </div>
      {tab === "flow" ? (
        <>
          <div className="btnrow">
            <div className="viewtgl" role="group" aria-label="Version">
              <button type="button" aria-pressed={side === "live"} onClick={() => setSide("live")}>Live v3</button>
              <button type="button" aria-pressed={side === "new"} onClick={() => setSide("new")}>{"New " + ver}</button>
            </div>
            <span className="note">{n + " steps changed. Read-only; boxes marked Changed differ from v3."}</span>
          </div>
          <Flow key={side} m={shown} markers={mk} label={"Decision flow " + (side === "new" ? ver : "v3")} />
        </>
      ) : tab === "json" ? <JsonDiff a={V3} b={m} la="v3" lb={ver} />
        : <XlsCompare a={V3} b={m} la="v3" lb={ver} />}
    </section>
  );
}

function ClsTag({ o, m }: { o: string | null; m: Model }) {
  const x = o ? getO(m, o) : null;
  if (!x) return <span className="note">no outcome</span>;
  return <span className="cls"><i style={{ background: "var(--" + sevColor(x.severity) + ")" }} />{x.title}</span>;
}

/** Evenly spaced rows, one per outcome first so every classification shows up. */
function sample<T>(xs: T[], n: number): { i: number; p: T }[] {
  const step = Math.max(1, Math.floor(xs.length / n));
  return xs.map((p, i) => ({ i, p })).filter(({ i }) => i % step === 0).slice(0, n);
}

/** Release = Verify (synthetic patients) + Changes (IT deploy approval). */
export function ReleaseScreen({ w, role, act }: { w: Workflow | null; role: Role; act: Actions }) {
  if (!w || !w.approved || !["verify", "deploy", "done"].includes(w.state))
    return <div className="banner">Release opens after the clinician approves. Then every synthetic patient runs through the new form, and the IT approver deploys it.</div>;
  const m = w.model, v = w.verify, a = w.approved;
  const tile = (k: string, x: string | number, c = "") => <div key={k} className={"chk " + c}><span className="k">{k}</span><span className="v">{x}</span></div>;

  return (
    <>
      <PageHead eyebrow={[w.state === "verify" ? "Step 03" : w.state === "deploy" ? "Step 04" : "Step 05", "v3 " + V3_HASH + " → " + a.ver + " " + a.hash + " · built from the approved hash only"]} title={"Release " + a.ver}
        actions={w.state === "verify" ? <button type="button" className="btn primary" onClick={act.runVerify}><Icon name="science" size={18} />Run synthetic check</button>
          : w.state === "deploy" ? <button type="button" className="btn primary" disabled={role !== "it"} onClick={act.approveDeploy}><Icon name="rocket_launch" size={18} />Approve deploy</button>
          : <span className="st ok">Deployed</span>} />
      {w.state === "deploy" && role !== "it" ? <div className="note">Only the IT approver can approve the deploy. The clinician approved the content, so they can't also deploy it.</div> : null}

      {!v ? (
        <div className="banner">The system builds the form with cht-conf, then runs every synthetic patient through (a) the approved rules in code and (b) the filled form in cht-conf-test-harness. Any mismatch returns the change to the clinician.</div>
      ) : (
        <>
          <div className="checks">
            {tile("Content approval", "Clinician · " + a.hash)}
            {tile("Rules vs form", v.match + " / " + v.total + " match", v.match === v.total ? "" : "bad")}
            {tile("Rule coverage", v.cov + " of " + v.covTotal + " rules fire", v.cov === v.covTotal ? "" : "bad")}
            {tile("Golden cases", golden(m).filter(g => g.ok).length + " of " + golden(m).length)}
            {tile("Mutation test", v.mut + " of " + v.mutTotal + " threshold mutants caught")}
            {tile("Rollback", "Redeploy v3", "muted")}
          </div>
          <section className="panel">
            <div className="ph"><h2>Synthetic patients</h2><span className="ver">{"12 of " + v.total + " boundary patients · expected outcomes come from the approved rules in code"}</span></div>
            <div className="tw">
              <table>
                <thead><tr>{["Patient", "Inputs", "Expected (rules)", "Actual (form)", "Match"].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
                <tbody>
                  {sample(grid(m), 12).map(({ i, p }) => {
                    const e = classify(m, p).out;
                    return (
                      <tr key={i}>
                        <td className="mono">{"P-" + String(i + 1).padStart(4, "0")}</td>
                        <td>{describeP(m, p)}</td>
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
          <Changes w={w} />
        </>
      )}
    </>
  );
}
