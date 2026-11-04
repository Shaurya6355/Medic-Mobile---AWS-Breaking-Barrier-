import { describe, expect, it } from "vitest";
import { modelSha, parseModel } from "../../src/logic/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raw = (): any => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "logic", "v1.json"), "utf8"));
const ok = (r: any) => {
  const p = parseModel(r);
  if (!p.ok) throw new Error(p.issues.join("\n"));
  return p.value;
};

const teamRow = (m: any): any => {
  for (const k of ["questions", "derived", "outcomes", "rules"]) {
    const r = m[k].find((x: any) => x.origin === "team");
    if (r) return r;
  }
  throw new Error("no team row in fixture");
};

describe("origin clinician: schema", () => {
  it("accepts clinician without a source", () => {
    const m = raw();
    const q = teamRow(m);
    q.origin = "clinician";
    delete q.source;
    expect(parseModel(m).ok).toBe(true);
  });

  it("still requires a source for guideline", () => {
    const m = raw();
    const q = m.questions.find((x: any) => x.origin === "guideline");
    delete q.source;
    const r = parseModel(m);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown origin", () => {
    const m = raw();
    m.questions[0].origin = "nurse";
    expect(parseModel(m).ok).toBe(false);
  });

  it("modelSha: changing origin team -> clinician is a content change (new hash, so new signatures)", () => {
    const m = raw();
    const q = teamRow(m);
    const before = modelSha(ok(m));
    q.origin = "clinician";
    expect(modelSha(ok(m))).not.toBe(before);
  });
});
