import { describe, expect, it } from "vitest";
import { makeFinding } from "../../src/validation/finding.js";
import type { Finding } from "../../src/validation/finding.js";
import { findingsFor, gates } from "../../src/validation/gates.js";
import { JARGON_RE } from "./helpers.js";

type Role = "program_officer" | "clinician";
const mk = (severity: "blocking" | "warning" | "info", decidedBy: Role, tag: string, code = "OPEN_QUESTION", audience: Role[] = [decidedBy]): Finding =>
  makeFinding({
    check: "t",
    code,
    severity,
    audience,
    decidedBy,
    subjects: [{ kind: "open_question", id: tag }],
    params: { id: tag, question: `Is ${tag} fine?`, route: decidedBy, affects: "" },
    source: [],
  });
const res = (findings: Finding[], claim: "PROVEN" | "NOT_PROVEN" = "PROVEN") => ({ findings, claim, claimText: claim === "PROVEN" ? "ok" : "Not proven: x." });

describe("gates", () => {
  it("with nothing blocking, everyone can go on", () => {
    const g = gates(res([mk("info", "clinician", "a"), mk("warning", "program_officer", "b")]));
    expect(g).toMatchObject({ canOfficerSign: true, canClinicianSign: true, canCompile: true });
    expect(g.blockers).toEqual({ officer: [], clinician: [], compile: [] });
    expect(g.summary).toMatch(/program officer can sign/i);
    expect(g.summary).toMatch(/clinician can sign/i);
    expect(g.summary).toMatch(/form can be built/i);
  });
  it("a blocking item for the program officer blocks the officer, then the clinician (the officer signs first), then the build", () => {
    const f = mk("blocking", "program_officer", "q5");
    const g = gates(res([f]));
    expect(g.canOfficerSign).toBe(false);
    expect(g.canClinicianSign).toBe(false);
    expect(g.canCompile).toBe(false);
    expect(g.blockers.officer).toEqual([f]);
    expect(g.blockers.clinician).toEqual([]);
    expect(g.blockers.compile).toEqual([f]);
    expect(g.summary).toMatch(/clinician cannot sign yet/i);
    expect(g.summary).toMatch(/waits for the program officer/i);
  });
  it("names a gap in the out-of-range value's age bands in plain words in the summary", () => {
    const f = mk("blocking", "clinician", "x", "OUTSIDE_AGE_BANDS_MISMATCH", ["clinician", "program_officer"]);
    expect(gates(res([f])).summary).toMatch(/rule for children outside the covered ages that leaves some of them out/);
  });
  it("a blocking item for the clinician blocks the clinician only; the officer may sign first", () => {
    const f = mk("blocking", "clinician", "q1");
    const g = gates(res([f]));
    expect(g.canOfficerSign).toBe(true);
    expect(g.canClinicianSign).toBe(false);
    expect(g.canCompile).toBe(false);
    expect(g.blockers).toEqual({ officer: [], clinician: [f], compile: [f] });
    expect(g.summary).toMatch(/program officer can sign/i);
    expect(g.summary).toMatch(/clinician cannot sign yet/i);
    expect(g.summary).toMatch(/form cannot be built/i);
  });
  it("a warning or information never blocks", () => {
    const g = gates(res([mk("warning", "clinician", "w"), mk("info", "program_officer", "i")]));
    expect(g.canCompile).toBe(true);
  });
  it("NOT_PROVEN blocks the build even when no finding blocks, and says why", () => {
    const g = gates(res([], "NOT_PROVEN"));
    expect(g.canOfficerSign).toBe(true);
    expect(g.canCompile).toBe(false);
    expect(g.summary).toMatch(/not proven/i);
  });
  it("the summary counts what stands in the way, in plain words, with no jargon", () => {
    const g = gates(res([mk("blocking", "program_officer", "a"), mk("blocking", "program_officer", "b", "GUIDELINE_FILE_MISMATCH"), mk("blocking", "clinician", "c", "SEVERITY_INVERSION")]));
    expect(g.summary).toMatch(/unanswered open question/i);
    expect(g.summary).toMatch(/different copy of the guideline/i);
    expect(g.summary).not.toMatch(JARGON_RE);
    expect(g.summary).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
  });
  it("is deterministic", () => {
    const fs = [mk("blocking", "program_officer", "a"), mk("blocking", "clinician", "c")];
    expect(gates(res(fs)).summary).toBe(gates(res(fs)).summary);
  });
});

describe("findingsFor", () => {
  const fs = [
    mk("info", "clinician", "i1", "OPEN_QUESTION", ["clinician", "program_officer"]),
    mk("blocking", "program_officer", "b1", "OPEN_QUESTION", ["program_officer"]),
    mk("blocking", "clinician", "b2", "OPEN_QUESTION", ["clinician", "program_officer"]),
    mk("warning", "clinician", "w1", "OPEN_QUESTION", ["clinician"]),
  ];
  it("shows each role only what is addressed to it, grouped from blocking to information", () => {
    const o = findingsFor(fs, "program_officer");
    expect(o.map((g) => g.severity)).toEqual(["blocking", "info"]);
    expect(o[0]!.findings.map((f) => f.subjects[0]!.id)).toEqual(["b1", "b2"]);
    const c = findingsFor(fs, "clinician");
    expect(c.map((g) => g.severity)).toEqual(["blocking", "warning", "info"]);
    expect(c[0]!.findings.map((f) => f.subjects[0]!.id)).toEqual(["b2"]);
  });
  it("puts what the role itself decides first within a group, and marks it", () => {
    const o = findingsFor(fs, "program_officer")[0]!.findings;
    expect(o.map((f) => f.yours)).toEqual([true, false]);
  });
  it("uses the wording of the role: the same finding reads differently for the two audiences", () => {
    const f = makeFinding({
      check: "t",
      code: "SEVERITY_INVERSION",
      severity: "blocking",
      audience: ["clinician", "program_officer"],
      decidedBy: "clinician",
      subjects: [{ kind: "rule", id: "R1" }],
      params: { child: "a child", firstOutcome: "A", firstRule: "R1", overriddenRule: "R2", overriddenOutcome: "B", openQuestion: "" },
      source: [],
    });
    expect(f.message).toMatch(/clinician decides/);
    const forOfficer = findingsFor([f], "program_officer")[0]!.findings[0]!;
    expect(forOfficer.message).toMatch(/program officer sends/);
    expect(findingsFor([f], "clinician")[0]!.findings[0]!.message).toBe(f.message);
    expect(forOfficer.id).toBe(f.id);
  });
  it("returns nothing for a role with nothing to see", () => {
    expect(findingsFor([mk("info", "clinician", "x")], "program_officer")).toEqual([]);
  });
});
