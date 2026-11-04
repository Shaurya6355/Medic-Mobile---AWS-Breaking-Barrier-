import { useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import * as api from "./api";
import { checksOf, gate, initialWorkflow } from "./domain/workflow";
import type { Role, Workflow } from "./domain/types";
import { ROLE_NAME, type Actions } from "./actions";
import { NextStrip, STAGES } from "./components/NextStrip";
import { GuidelinesScreen } from "./screens/GuidelinesScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { ReleaseScreen } from "./screens/ReleaseScreen";
import { HistoryScreen } from "./screens/HistoryScreen";

const SCREENS: [string, string][] = [["/guidelines", "Guidelines"], ["/review", "Review"], ["/release", "Release"], ["/history", "History"]];
const EMPTY = initialWorkflow("none");

export default function App() {
  const [role, setRole] = useState<Role>("po");
  const [w, setW] = useState<Workflow | null>(null);
  const [sel, setSel] = useState("scope");
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const cur = w ?? EMPTY;
  const checks = useMemo(() => checksOf(cur), [cur]);

  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  const run = async (p: Promise<Workflow>, after?: (x: Workflow) => void) => {
    setError(null);
    try { const x = await p; setW(x); after?.(x); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  /** After a decision, open the next open item for this role. */
  const nextAfter = (x: Workflow, current: string) => {
    const g = gate(x, checksOf(x));
    const list = x.state === "clinician" ? g.reqLeft : x.state === "po_revise" ? g.unresolved : [];
    const nxt = list.find(id => id !== current);
    if (nxt) setTimeout(() => setSel(nxt), 350);
  };
  const pick = (id: string) => {
    if (id.startsWith("F-")) {
      const f = cur.flags.find(x => x.id === id);
      if (f) setSel(f.about);
      nav("/review");
      setTimeout(() => document.getElementById("flag-" + id)?.scrollIntoView({ block: "center" }), 60);
      return;
    }
    setSel(id);
    nav("/review");
  };

  const act: Actions = {
    createDraft: args => run(api.createDraft(args), () => nav("/review")),
    edit: (item, field, patch) => { if (w) run(api.saveEdit(w.id, { item, field, patch })); },
    send: () => { if (w) run(api.sendToClinician(w.id)); },
    decide: (item, d) => { if (w) run(api.submitReview(w.id, item, d), x => { if (d) nextAfter(x, item); }); },
    flag: (fid, choice, note) => { if (w) run(api.decideFlag(w.id, fid, choice, note)); },
    returnToPO: () => { if (w) run(api.returnToPO(w.id)); },
    sug: (item, outcome, patch) => { if (w) run(api.decideSuggestion(w.id, item, outcome, patch), x => { if (outcome === "accepted") nextAfter(x, item); }); },
    approveAll: () => { if (w) run(api.approve(w.id), () => nav("/release")); },
    runVerify: () => { if (w) run(api.runVerify(w.id)); },
    approveDeploy: () => { if (w) run(api.approveDeploy(w.id)); },
    setRole,
    reset: () => { setW(null); setSel("scope"); setError(null); nav("/guidelines"); },
  };

  const stage = STAGES.find(s => s.key === cur.state)!;
  const actionPath = stage.owner === role || stage.owner === "system" ? stage.path : null;

  return (
    <>
      <header className="apphead">
        <div className="hin">
          <span className="brand">Guideline to Form</span>
          <nav className="nav" aria-label="Screens">
            {SCREENS.map(([p, l]) => (
              <NavLink key={p} to={p} className={({ isActive }) => (isActive ? "on" : "")}>
                {l}{actionPath === p ? <span className="ndot" aria-label="your next step is here" /> : null}
              </NavLink>
            ))}
          </nav>
          <label className="nx-who" htmlFor="role">
            Viewing as
            <select id="role" value={role} onChange={e => setRole(e.target.value as Role)}>
              {(Object.keys(ROLE_NAME) as Role[]).map(k => <option key={k} value={k}>{ROLE_NAME[k]}</option>)}
            </select>
          </label>
        </div>
      </header>
      <NextStrip w={cur} role={role} checks={checks} path={pathname} act={act} go={nav} pick={pick} />
      <main className="app">
        {error ? <div className="banner" role="alert">{error}</div> : null}
        <Routes>
          <Route path="/" element={<Navigate to="/guidelines" replace />} />
          <Route path="/guidelines" element={<GuidelinesScreen w={w} role={role} act={act} />} />
          <Route path="/review" element={<ReviewScreen w={w} role={role} sel={sel} setSel={setSel} act={act} checks={checks} />} />
          <Route path="/release" element={<ReleaseScreen w={w} role={role} act={act} />} />
          <Route path="/history" element={<HistoryScreen w={w} act={act} />} />
          <Route path="*" element={<Navigate to="/guidelines" replace />} />
        </Routes>
        <div className="foot">
          <span>Mock-up. Example data based on the WHO IMCI 2008 to 2014 revision. Not clinical advice.</span>
          <span>{"“Viewing as” stands in for three separate logins."}</span>
        </div>
      </main>
    </>
  );
}
