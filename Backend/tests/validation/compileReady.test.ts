import { describe, expect, it } from "vitest";
import { compileReady } from "../../src/validation/checks/compileReady.js";
import { demoSettings, matchedCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void, settings?: (s: any) => void) => {
  const s = demoSettings();
  settings?.(s);
  return compileReady({ ...matchedCtx(mutate), compileSettings: s });
};
const idx = (m: any, id: string) => m.outcomes.findIndex((o: any) => o.id === id);

describe("compileReady", () => {
  it("without settings nothing is reported", () => {
    expect(compileReady(matchedCtx())).toEqual([]);
  });
  it("v1.json with the demo settings builds: 4 on-return follow-ups are not compiled, 1 window uses the team default", () => {
    const fs = run();
    expect(fs.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(fs.map((f) => f.code).sort()).toEqual(["FOLLOWUP_NOT_COMPILED", "FOLLOWUP_NOT_COMPILED", "FOLLOWUP_NOT_COMPILED", "FOLLOWUP_NOT_COMPILED", "TEAM_DEFAULT_WINDOW"]);
  });
  it("on-return follow-ups are information for the clinician: how will the return date be known", () => {
    const f = run().filter((x) => x.code === "FOLLOWUP_NOT_COMPILED");
    expect(f.map((x) => x.subjects[0]!.id).sort()).toEqual(["refer_outside_age_range", "refer_urgent", "refer_urgent_outside_age_range", "refer_urgent_with_antibiotic"]);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.decidedBy).toBe("clinician");
    expect(f[0]!.audience[0]).toBe("clinician");
    expect(f[0]!.message).toContain("return date");
  });
  it("a missing window with a team default is a warning for the officer, pointing at Q5", () => {
    const f = run().find((x) => x.code === "TEAM_DEFAULT_WINDOW")!;
    expect(f.severity).toBe("warning");
    expect(f.decidedBy).toBe("program_officer");
    expect(f.subjects).toEqual([{ kind: "follow_up", id: "treat_fast_breathing_at_home" }]);
    expect(f.params["openQuestion"]).toBe("Q5");
    expect(f.params["days"]).toBe(7);
    expect(f.message).toContain("7 days");
    expect(f.message).toContain("Q5");
  });
  it("a window given in the model needs no default", () => {
    const fs = run((m) => { m.outcomes[idx(m, "treat_fast_breathing_at_home")].follow_up.task_window_days_after_due = 4; });
    expect(fs.map((f) => f.code)).not.toContain("TEAM_DEFAULT_WINDOW");
  });
  it("missing form title, icon, who the form is for, and the window block, listing everything in plain words", () => {
    const fs = run(undefined, (s) => { s.formTitle = " "; s.icon = ""; s.contactTypes = { person: false, place: false }; delete s.taskWindowDays; });
    const b = fs.filter((f) => f.code === "COMPILE_NOT_READY");
    expect(b).toHaveLength(1);
    const f = b[0]!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("program_officer");
    expect(f.audience).toEqual(["program_officer"]);
    expect(f.message).toContain("form title");
    expect(f.message).toContain("icon");
    expect(f.message).toMatch(/person or a place/);
    expect(f.message).toContain("Fast breathing (pneumonia)");
    expect(f.message).toContain("Q5");
    expect(f.message).not.toMatch(/settings\.|outcomes\./);
    expect(fs.map((x) => x.code)).not.toContain("TEAM_DEFAULT_WINDOW");
  });
  it("a scheduled follow-up without a day count blocks as well", () => {
    const fs = run((m) => { m.outcomes[idx(m, "treat_fast_breathing_at_home")].follow_up.due_in_days = null; });
    const f = fs.find((x) => x.code === "COMPILE_NOT_READY")!;
    expect(f.message).toContain("number of days");
  });
  it("is deterministic", () => {
    expect(run().map((f) => f.id)).toEqual(run().map((f) => f.id));
  });
});
