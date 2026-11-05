import { gate } from "../domain/workflow";
import { itemLabel } from "../domain/logic";
import type { Check, Role, WfState, Workflow } from "../domain/types";
import { ROLE_NAME, type Actions } from "../actions";
import { Icon } from "./Icon";

type Owner = Role | "system" | null;
export const STAGES: { key: WfState; label: string; kicker: string; owner: Owner; path: string }[] = [
  { key: "none", label: "Pick guideline pages", kicker: "Clinician", owner: "clinician", path: "/guidelines" },
  { key: "clinician", label: "Clinical review", kicker: "AI agent · Clinician", owner: "clinician", path: "/review" },
  { key: "verify", label: "Synthetic check", kicker: "System", owner: "system", path: "/release" },
  { key: "deploy", label: "IT approves deploy", kicker: "IT approver", owner: "it", path: "/release" },
  { key: "done", label: "Deployed", kicker: "Done", owner: null, path: "/history" },
];

interface Btn { label: string; fn: () => void }
interface Next { mine: boolean; title: string; todo: { id: string; label: string }[]; primary: Btn | null }

/** The single next step for the current role. */
function nextStep(w: Workflow, role: Role, checks: Check[], path: string, act: Actions, go: (p: string) => void): Next {
  const stage = STAGES.find(s => s.key === w.state)!;
  const owner = stage.owner;
  const mine = owner === role || owner === "system";
  const res: Next = { mine, title: "", todo: [], primary: null };

  if (!mine && owner) {
    const what = owner === "clinician" ? (w.state === "none" ? "start a workflow" : "review and approve the rules") : "approve the deploy";
    res.title = "Waiting for the " + ROLE_NAME[owner as Role].toLowerCase() + " to " + what + ".";
    res.primary = { label: "Switch to " + ROLE_NAME[owner as Role], fn: () => { act.setRole(owner as Role); go(stage.path); } };
    return res;
  }
  switch (w.state) {
    case "none":
      res.title = path === "/guidelines" ? "Pick a guideline, pathway and pages on the right, then start the workflow." : "Start by picking the guideline pages for this pathway.";
      if (path !== "/guidelines") res.primary = { label: "Go to Guidelines", fn: () => go("/guidelines") };
      break;
    case "clinician": {
      const g = gate(w, checks);
      // On Review the hand-over card says this; the strip only points there from other screens.
      if (path === "/review") break;
      res.todo = g.blockIds.map(id => ({ id, label: itemLabel(id) }));
      res.title = g.ready ? "The AI agent's checks pass and every question is answered. Approve when the flow looks right."
        : (g.asks.length ? g.asks.length + " question" + (g.asks.length > 1 ? "s" : "") + " for you in the assistant" : "") + (g.asks.length && g.blockIds.length ? "; " : "") + (g.blockIds.length ? g.blockIds.length + " blocking problem" + (g.blockIds.length > 1 ? "s" : "") + " to fix" : "") + ".";
      res.primary = path !== "/review" ? { label: "Open Review", fn: () => go("/review") } : null;
      break;
    }
    case "verify":
      res.title = "Content approved. Build the form and run every synthetic patient through it.";
      res.primary = path === "/release" ? null : { label: "Run synthetic check", fn: () => { go("/release"); act.runVerify(); } };
      break;
    case "deploy":
      res.title = path === "/release" ? "Check the form changes and the test report, then approve the deploy." : "The synthetic check passed. Review the changes for deploy.";
      res.primary = path === "/release" ? null : { label: "Go to Release", fn: () => go("/release") };
      break;
    case "done":
      res.title = "Deployed. Every step, with its version and hash, is in the audit log.";
      res.primary = path === "/history" ? { label: "Start a new demo", fn: act.reset } : { label: "Open History", fn: () => go("/history") };
  }
  return res;
}

export function NextStrip({ w, role, checks, path, act, go, pick }: { w: Workflow; role: Role; checks: Check[]; path: string; act: Actions; go: (p: string) => void; pick: (id: string) => void }) {
  const n = nextStep(w, role, checks, path, act, go);
  const at = STAGES.findIndex(s => s.key === w.state);
  return (
    <section className={"nx" + (n.mine ? " mine" : "")} aria-label="What to do next">
      <ol className="stepper" aria-label="Progress">
        {STAGES.map((s, k) => (
          <li key={s.key}>
            <button type="button" className={"step" + (k < at ? " done" : k === at ? " now" : "")} aria-current={k === at ? "step" : undefined} onClick={() => go(s.path)}>
              <span className="step-n">{k < at ? <Icon name="check" size={20} /> : k + 1}</span>
              <span className="step-t"><span className="step-k">{s.kicker}</span><span className="step-l">{s.label}</span></span>
            </button>
          </li>
        ))}
      </ol>
      {n.title || n.primary ? <div className="nx-in">
        <div className="nx-main">
          <div className="nx-title">{n.title}</div>
          {n.todo.length ? (
            <div className="nx-todo">
              {n.todo.slice(0, 6).map(t => <button key={t.id} type="button" className="chipb" onClick={() => pick(t.id)}>{t.label}</button>)}
              {n.todo.length > 6 ? <span className="note">+{n.todo.length - 6} more</span> : null}
            </div>
          ) : null}
        </div>
        {n.primary ? <div className="btnrow"><button type="button" className={"btn " + (n.mine ? "primary" : "")} onClick={n.primary.fn}>{n.primary.label}</button></div> : null}
      </div> : null}
    </section>
  );
}
