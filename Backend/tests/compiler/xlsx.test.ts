import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildForm } from "../../src/compiler/form.js";
import { readSheets, writeFormXlsx } from "../../src/compiler/xlsx.js";
import { demoSettings, v1 } from "./helpers.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});

describe("writeFormXlsx", () => {
  it("writes survey, choices and settings sheets with XLSForm headers", async () => {
    const form = buildForm(v1(), demoSettings(), "preview-12345678");
    const buf = await writeFormXlsx(form);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["survey", "choices", "settings"]);
    const sheets = await readSheets(buf);
    expect(sheets.survey?.[0]).toEqual([
      "type",
      "name",
      "label::en",
      "required",
      "relevant",
      "appearance",
      "constraint",
      "constraint_message::en",
      "calculation",
      "default",
    ]);
    expect(sheets.survey).toHaveLength(form.survey.length + 1);
    const outcome = sheets.survey?.find((r) => r[1] === "outcome");
    expect(outcome?.[8]).toBe(form.survey.find((r) => r.name === "outcome")?.calculation);
    expect(sheets.choices).toEqual([
      ["list_name", "name", "label::en"],
      ["yes_no", "yes", "Yes"],
      ["yes_no", "no", "No"],
    ]);
    expect(sheets.settings).toEqual([
      ["form_title", "form_id", "version", "default_language", "style"],
      ["Cough and fast breathing (demo)", "cough_fast_breathing", "preview-12345678", "en", "pages"],
    ]);
    expect(wb.creator).toBe("logic-model-compiler");
    expect(wb.created.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  it("is byte-for-byte deterministic regardless of the clock", async () => {
    const form = buildForm(v1(), demoSettings(), "v");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const a = await writeFormXlsx(form);
    vi.setSystemTime(new Date("2031-07-09T23:59:58Z"));
    const b = await writeFormXlsx(form);
    expect(sha(a)).toBe(sha(b));
  });
});
