import { describe, expect, it } from "vitest";
import { computeFindings, ensureFlags, flagsKey } from "../../src/signoff/checks.js";
import { modelSha } from "../../src/logic/index.js";
import { FlagsDocumentSchema } from "../../src/validation/flags.js";
import { draftV1, seed, shaOf, testInputs } from "./helpers.js";

const read = async (artifacts: { get(k: string): Promise<Uint8Array> }, key: string) => JSON.parse(new TextDecoder().decode(await artifacts.get(key))) as unknown;
const withScope = (below: number) => {
  const m = draftV1();
  m.scope.age_months_below = below;
  return m;
};

/** The flags are stored with every version's checks, as flags.json in the run's artifacts, for the front end. */
describe("the stored flags document", () => {
  it("is stored with the findings, keyed to the version's content and inputs, and holds only the cross-check flags", async () => {
    const second = withScope(59);
    const s = await seed("awaiting_officer", [draftV1()], { inputs: { ...testInputs(), crossCheck: { model: second } } });
    const { record } = await computeFindings(s.signoff.io, "r1", 1);
    const key = flagsKey("r1", shaOf(draftV1()), record.inputsSha);
    expect(await s.artifacts.exists(key)).toBe(true);
    const doc = FlagsDocumentSchema.parse(await read(s.artifacts, key));
    expect(doc).toMatchObject({ mode: "logic_models", runId: "r1", n: 1, modelSha: shaOf(draftV1()), inputsSha: record.inputsSha, comparison: "ran", secondDraftSha: modelSha(second) });
    expect(doc.flags.length).toBeGreaterThan(1);
    expect(doc.flags.every((f) => f.check === "crossCheck" && f.status === "open" && f.severity !== "blocking")).toBe(true);
    expect(doc.flags.some((f) => f.code === "CROSS_CHECK_SCOPE_DIFFERS")).toBe(true);
    expect(doc.summary.flagCount).toBe(doc.flags.length);
    expect(doc.flags[0]?.messages.clinician).toBeTruthy();
    expect(doc.flags[0]?.messages.program_officer).toBeTruthy();
  });

  it("is stored even when there is nothing to compare, and says the comparison did not run", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const { record } = await computeFindings(s.signoff.io, "r1", 1);
    const doc = FlagsDocumentSchema.parse(await read(s.artifacts, flagsKey("r1", shaOf(draftV1()), record.inputsSha)));
    expect(doc).toMatchObject({ comparison: "not_run", secondDraftSha: null, flags: [], summary: { flagCount: 0 } });
  });

  it("says when the second draft could not be read", async () => {
    const s = await seed("awaiting_officer", [draftV1()], { inputs: { ...testInputs(), crossCheck: { invalid: ["questions: Required"] } } });
    const { record } = await computeFindings(s.signoff.io, "r1", 1);
    const doc = FlagsDocumentSchema.parse(await read(s.artifacts, flagsKey("r1", shaOf(draftV1()), record.inputsSha)));
    expect(doc.comparison).toBe("second_draft_invalid");
    expect(doc.flags.map((f) => f.code)).toEqual(["CROSS_CHECK_SECOND_DRAFT_INVALID"]);
  });

  it("is computed and stored when it is asked for and missing, and then served as stored", async () => {
    const s = await seed("awaiting_officer", [draftV1()], { inputs: { ...testInputs(), crossCheck: { model: withScope(59) } } });
    const first = await ensureFlags(s.signoff.io, "r1", 1);
    expect(await s.artifacts.exists(first.key)).toBe(true);
    const again = await ensureFlags(s.signoff.io, "r1", 1);
    expect(again.key).toBe(first.key);
    expect(again.doc).toEqual(first.doc);
  });

  it("is never read as proof of anything: a planted document for other content is ignored and recomputed", async () => {
    const s = await seed("awaiting_officer", [draftV1()], { inputs: { ...testInputs(), crossCheck: { model: withScope(59) } } });
    const real = await ensureFlags(s.signoff.io, "r1", 1);
    await s.artifacts.put(real.key, JSON.stringify({ ...real.doc, modelSha: "0".repeat(64), flags: [] }), "application/json");
    const healed = await ensureFlags(s.signoff.io, "r1", 1);
    expect(healed.doc.modelSha).toBe(shaOf(draftV1()));
    expect(healed.doc.flags.length).toBeGreaterThan(0);
  });
});
