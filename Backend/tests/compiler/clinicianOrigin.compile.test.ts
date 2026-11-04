import { describe, expect, it } from "vitest";
import { buildForm } from "../../src/compiler/form.js";
import { buildTasks } from "../../src/compiler/tasks.js";
import { checkCompileReady } from "../../src/compiler/readiness.js";
import { demoSettings, parse, rawV1, v1 } from "./helpers.js";

const swap = (v: unknown, from: string, to: string): unknown => {
  if (Array.isArray(v)) return v.map((x) => swap(x, from, to));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "origin" && x === from ? to : swap(x, from, to)]));
  }
  return v;
};

const teamModel = () => v1();
const clinicianModel = () => parse(swap(rawV1(), "team", "clinician"));
const stripOrigin = (entries: { origin: string }[]) => entries.map((e) => ({ ...e, origin: "-" }));

describe("origin clinician", () => {
  it("the swap really changes team rows to clinician", () => {
    expect(JSON.stringify(clinicianModel())).toContain('"origin":"clinician"');
    expect(JSON.stringify(clinicianModel())).not.toContain('"origin":"team"');
  });

  it("compiles identically to team origin except for the sourcemap origin value", () => {
    const s = demoSettings();
    const t = teamModel();
    const c = clinicianModel();
    const ft = buildForm(t, s, "preview-x");
    const fc = buildForm(c, s, "preview-x");
    expect(fc.survey).toEqual(ft.survey);
    expect(fc.choices).toEqual(ft.choices);
    expect(fc.settings).toEqual(ft.settings);
    expect(fc.properties).toEqual(ft.properties);
    expect(stripOrigin(fc.sourcemap)).toEqual(stripOrigin(ft.sourcemap));
    const tt = buildTasks(t, s, checkCompileReady(t, s).taskWindows, "sha");
    const tc = buildTasks(c, s, checkCompileReady(c, s).taskWindows, "sha");
    expect(tc.js).toBe(tt.js);
    expect(tc.translations).toEqual(tt.translations);
    expect(stripOrigin(tc.sourcemap)).toEqual(stripOrigin(tt.sourcemap));
    expect(checkCompileReady(c, s)).toEqual(checkCompileReady(t, s));
  });

  it("carries clinician through to the sourcemap unchanged", () => {
    const s = demoSettings();
    const c = clinicianModel();
    const form = buildForm(c, s, "preview-x");
    const tasks = buildTasks(c, s, checkCompileReady(c, s).taskWindows, "sha");
    const origins = new Set([...form.sourcemap, ...tasks.sourcemap].map((e) => e.origin));
    expect(origins.has("clinician")).toBe(true);
    expect(origins.has("team")).toBe(false);
  });
});
