/**
 * Deterministic XLSForm writer (exceljs).
 *
 * exceljs stamps every zip entry with the current time, so two writes of the same form differ
 * byte-wise. We fix the workbook metadata (creator, created, modified) to constants and then
 * re-pack the zip with JSZip, giving every entry the same fixed date. The fixed date is built
 * from LOCAL calendar fields because the zip (DOS) timestamp stores local fields: this keeps the
 * bytes identical across time zones too.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { SURVEY_COLUMNS, SURVEY_HEADERS, type BuiltForm } from "./form.js";

export const WORKBOOK_CREATOR = "logic-model-compiler";
export const WORKBOOK_DATE = new Date("2000-01-01T00:00:00.000Z");
const zipEntryDate = (): Date => new Date(2000, 0, 1, 0, 0, 0);

export async function writeFormXlsx(form: BuiltForm): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = WORKBOOK_CREATOR;
  wb.lastModifiedBy = WORKBOOK_CREATOR;
  wb.created = WORKBOOK_DATE;
  wb.modified = WORKBOOK_DATE;

  const survey = wb.addWorksheet("survey");
  survey.addRow(SURVEY_COLUMNS.map((c) => SURVEY_HEADERS[c]));
  for (const r of form.survey) survey.addRow(SURVEY_COLUMNS.map((c) => r[c] ?? null));

  const choices = wb.addWorksheet("choices");
  choices.addRow(["list_name", "name", "label::en"]);
  for (const c of form.choices) choices.addRow([c.list_name, c.name, c.label]);

  const settings = wb.addWorksheet("settings");
  settings.addRow(["form_title", "form_id", "version", "default_language", "style"]);
  const s = form.settings;
  settings.addRow([s.form_title, s.form_id, s.version, s.default_language, s.style]);

  const raw = Buffer.from(await wb.xlsx.writeBuffer());
  return normaliseZip(raw);
}

/** Re-pack a zip with fixed entry dates, keeping entry order and contents. */
export async function normaliseZip(buf: Buffer): Promise<Buffer> {
  const src = await JSZip.loadAsync(buf);
  const out = new JSZip();
  for (const name of Object.keys(src.files)) {
    const entry = src.files[name] as JSZip.JSZipObject;
    if (entry.dir) out.file(name, null, { dir: true, date: zipEntryDate() });
    else out.file(name, await entry.async("uint8array"), { date: zipEntryDate() });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Read every sheet back as rows of strings ("" for empty), padded to the header width. */
export async function readSheets(buf: Buffer): Promise<Record<string, string[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: Record<string, string[][]> = {};
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    let width = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const vals: string[] = [];
      const count = n === 1 ? row.cellCount : Math.max(width, row.cellCount);
      for (let i = 1; i <= count; i++) {
        const v = row.getCell(i).value;
        vals.push(v === null || v === undefined ? "" : String(v));
      }
      if (n === 1) width = vals.length;
      while (vals.length < width) vals.push("");
      rows.push(vals);
    });
    out[ws.name] = rows;
  }
  return out;
}
