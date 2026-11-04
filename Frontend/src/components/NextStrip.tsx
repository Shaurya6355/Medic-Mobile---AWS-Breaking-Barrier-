import { gate } from "../domain/workflow";
import { itemLabel } from "../domain/logic";
import type { Check, Role, WfState, Workflow } from "../domain/types";
import { ROLE_NAME, type Actions } from "../actions";

type Owner = Role | "system" | null;
export const STAGES: { key: WfState; label: string; owner: Owner; path: string }[] = [
  { key: "none", label: "Pick guideline pages", owner: "clinician", path: "/guidelines" },
  { key: "clinician", label: "AI agent checks · clinical review", owner: "clinician", path: "/review" },
  { key: "verify", label: "Synthetic check", owner: "system", path: "/release" },
  { key: "deploy", label: "IT approves deploy", owner: "it", path: "/release" },
  { key: "done", label: "Deployed", owner: null, path: "/history" },
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
      res.todo = g.blockIds.map(id => ({ id, label: itemLabel(id) })).concat(g.asks.map(f => ({ id: f.id, label: "Question " + f.id.slice(2) })));
      res.title = g.ready ? "The AI agent's checks pass and every question is answered. Approve when the flow looks right."
        : (g.asks.length ? g.asks.length + " question" + (g.asks.length > 1 ? "s" : "") + " for you in the assistant" : "") + (g.asks.length && g.blockIds.length ? "; " : "") + (g.blockIds.length ? g.blockIds.length + " blocking problem" + (g.blockIds.length > 1 ? "s" : "") + " to fix" : "") + ".";
      res.primary = path !== "/review" ? { label: "Open Review", fn: () => go("/review") } : null;
      break;
    }
    case "verify":
      res.title = "Content approved. Build the form and run every synthetic patient through it.";
      res.primary = { label: "Run synthetic check", fn: () => { go("/release"); act.runVerify(); } };
      break;
    case "deploy":
      res.title = path === "/release" ? "Check the form changes and the test report, then approve the deploy." : "The synthetic check passed. Review the changes for deploy.";
      res.primary = path === "/release" ? { label: "Approve deploy", fn: act.approveDeploy } : { label: "Go to Release", fn: () => go("/release") };
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
    <div className={"nx" + (n.mine ? " mine" : "")} role="region" aria-label="What to do next">
      <div className="nx-in">
        <div className="nx-main">
          <div className="nx-steps" aria-label="Progress">
            {STAGES.map((s, k) => (
              <span key={s.key} style={{ display: "contents" }}>
                {k ? <i aria-hidden="true">/</i> : null}
                <span className={k < at ? "done" : k === at ? "now" : ""} aria-current={k === at ? "step" : undefined}>{(k < at ? "✓ " : "") + s.label}</span>
              </span>
            ))}
          </div>
          <div className="nx-title">{n.title}</div>
          {n.todo.length ? (
            <div className="nx-todo">
              {n.todo.slice(0, 6).map(t => <button key={t.id} type="button" className="chipb" onClick={() => pick(t.id)}>{t.label}</button>)}
              {n.todo.length > 6 ? <span className="note">+{n.todo.length - 6} more</span> : null}
            </div>
          ) : null}
        </div>
        {n.primary ? <div className="btnrow"><button type="button" className={"btn " + (n.mine ? "primary" : "")} onClick={n.primary.fn}>{n.primary.label}</button></div> : null}
      </div>
    </div>
  );
}
