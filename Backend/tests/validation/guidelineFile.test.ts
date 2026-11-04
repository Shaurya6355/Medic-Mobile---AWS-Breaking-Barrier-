import { describe, expect, it } from "vitest";
import { guidelineFile } from "../../src/validation/checks/guidelineFile.js";
import { matchedCtx, realCtx } from "./helpers.js";

describe("guidelineFile", () => {
  it("fires on the real pair: v1 was written from a different copy than the uploaded one", () => {
    const fs = guidelineFile(realCtx());
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("GUIDELINE_FILE_MISMATCH");
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("program_officer");
    expect(f.audience).toEqual(["program_officer"]);
    expect(f.message).toContain("different copy of the guideline");
    expect(f.message).not.toMatch(/sha|hash|checksum/i);
  });
  it("passes when the hash matches (patched copy)", () => {
    expect(guidelineFile(matchedCtx())).toEqual([]);
  });
  it("is silent without a document (quoteGrounding reports that)", () => {
    expect(guidelineFile({ model: realCtx().model })).toEqual([]);
  });
});
