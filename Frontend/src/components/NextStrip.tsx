import { gate } from "../domain/workflow";
import { itemLabel } from "../domain/logic";
import type { Check, Role, WfState, Workflow } from "../domain/types";
import { ROLE_NAME, type Actions } from "../actions";

type Owner = Role | "system" | null;
export const STAGES: { key: WfState; label: string; owner: Owner; path: string }[] = [
  { key: "none", label: "Pick guideline pages", owner: "po", path: "/guidelines" },
  { key: "po_draft", label: "Check & edit draft", owner: "po", path: "/review" },
  { key: "clinician", label: "Clinical review", owner: "clinician", path: "/review" },
  { key: "po_revise", label: "Apply feedback", owner: "po", path: "/review" },
  { key: "verify", label: "Synthetic check", owner: "system", path: "/release" },
  { key: "deploy", label: "Approve deploy", owner: "it", path: "/release" },
  { key: "done", label: "Deployed", owner: null, path: "/history" },
];

interface Btn { label: string; fn: () => void; bad?: boolean }
interface Next { mine: boolean; title: string; todo: { id: string; label: string }[]; primary: Btn | null }

/** The single next step for the current role. */
function nextStep(w: Workflow, role: Role, checks: Check[], path: string, act: Actions, go: (p: string) => void, pick: (id: string) => void): Next {
  const g = gate(w, checks);
  const stage = STAGES.find(s => s.key === w.state)!;
  const owner = stage.owner;
  const mine = owner === role || owner === "system";
  const asTodo = (ids: string[]) => ids.map(id => ({ id, label: itemLabel(id) }));
  const res: Next = { mine, title: "", todo: [], primary: null };

  if (!mine && owner) {
    const what = owner === "po" ? ({ none: "create the workflow draft", po_draft: "check the draft and send it", po_revise: "apply the clinician's feedback" } as Record<string, string>)[w.state]
      : owner === "clinician" ? "review round " + w.round : "approve the deploy";
    res.title = "Waiting for the " + ROLE_NAME[owner as Role].toLowerCase() + " to " + what + ".";
    res.primary = { label: "Switch to " + ROLE_NAME[owner as Role], fn: () => { act.setRole(owner as Role); go(stage.path); } };
    return res;
  }
  switch (w.state) {
    case "none":
      res.title = path === "/guidelines" ? "Pick a guideline, pathway and pages on the right, then create the workflow draft." : "Start by picking the guideline pages for this pathway.";
      if (path !== "/guidelines") res.primary = { label: "Go to Guidelines", fn: () => go("/guidelines") };
      break;
    case "po_draft":
      res.todo = asTodo(g.blockIds.concat(g.poFlags.map(f => f.id)));
      res.title = res.todo.length ? "Check the AI draft. Clear " + res.todo.length + " item" + (res.todo.length > 1 ? "s" : "") + " before you can send it." : "The draft passes every check. Look through the changed boxes, then send it to the clinician.";
      res.primary = res.todo.length ? { label: "Go to next item", fn: () => pick(res.todo[0].id) } : { label: "Send to clinician", fn: act.send };
      break;
    case "clinician":
      res.todo = asTodo(g.reqLeft.concat(g.clinFlags.map(f => f.id)));
      if (res.todo.length) { res.title = "Round " + w.round + ": review " + res.todo.length + " item" + (res.todo.length > 1 ? "s" : "") + ". Approve each, or request a change."; res.primary = { label: "Review next", fn: () => pick(res.todo[0].id) }; }
      else if (g.changesNow.length) { res.title = "Reviewed. You requested " + g.changesNow.length + " change" + (g.changesNow.length > 1 ? "s" : "") + "; send them to the program officer."; res.primary = { label: "Return to PO with feedback", fn: act.returnToPO, bad: true }; }
      else { res.title = "Everything in round " + w.round + " is approved. Approve the whole version."; res.primary = { label: "Approve all", fn: act.approveAll }; }
      break;
    case "po_revise":
      res.todo = asTodo(g.unresolved.concat(g.blockIds));
      res.title = g.unresolved.length ? "The clinician requested " + g.changesNow.length + " change" + (g.changesNow.length > 1 ? "s" : "") + ". For each one, accept, edit or discard the AI suggestion."
        : g.blockIds.length ? "Fix the blocking checks before resending." : "All feedback is handled. Send round " + (w.round + 1) + " to the clinician.";
      res.primary = res.todo.length ? { label: "Open next request", fn: () => pick(res.todo[0].id) } : { label: "Resend to clinician (round " + (w.round + 1) + ")", fn: act.send };
      break;
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
  const n = nextStep(w, role, checks, path, act, go, pick);
  const at = STAGES.findIndex(s => s.key === w.state);
  const shown = STAGES.filter(s => s.key !== "po_revise" || w.state === "po_revise");
  return (
    <div className={"nx" + (n.mine ? " mine" : "")} role="region" aria-label="What to do next">
      <div className="nx-in">
        <div className="nx-main">
          <div className="nx-steps" aria-label="Progress">
            {shown.map((s, i) => {
              const k = STAGES.indexOf(s), cls = k < at ? "done" : k === at ? "now" : "";
              return (
                <span key={s.key} style={{ display: "contents" }}>
                  {i ? <i aria-hidden="true">/</i> : null}
                  <span className={cls} aria-current={k === at ? "step" : undefined}>
                    {(k < at ? "✓ " : "") + (s.key === "clinician" && w.round ? s.label + " · round " + w.round : s.label)}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="nx-title">{n.title}</div>
          {n.todo.length ? (
            <div className="nx-todo">
              {n.todo.slice(0, 6).map(t => <button key={t.id} type="button" className="chipb" onClick={() => pick(t.id)}>{t.label}</button>)}
              {n.todo.length > 6 ? <span className="note">+{n.todo.length - 6} more</span> : null}
            </div>
          ) : null}
        </div>
        {n.primary ? (
          <div className="btnrow">
            <button type="button" className={"btn " + (n.primary.bad ? "bad" : n.mine ? "primary" : "")} onClick={n.primary.fn}>{n.primary.label}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
