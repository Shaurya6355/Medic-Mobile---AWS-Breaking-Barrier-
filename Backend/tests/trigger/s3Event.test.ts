import { describe, it, expect } from "vitest";
import { parseS3Event } from "../../src/trigger/s3Event.js";

const rec = (key: string, eventName = "ObjectCreated:Put", bucket = "b1") => ({
  eventName,
  s3: { bucket: { name: bucket }, object: { key } },
});
const body = (...records: unknown[]) => JSON.stringify({ Records: records });

describe("parseS3Event", () => {
  it("parses a real-shaped notification", () => {
    expect(parseS3Event(body(rec("runs/r-1/input/guideline.pdf")))).toEqual([
      { bucket: "b1", key: "runs/r-1/input/guideline.pdf", runId: "r-1" },
    ]);
  });
  it("url-decodes keys", () => {
    expect(parseS3Event(body(rec("runs%2Fr-1%2Finput%2Fguideline.pdf")))).toHaveLength(1);
    expect(parseS3Event(body(rec("runs/r+1/input/guideline.pdf")))).toEqual([]);
  });
  it("ignores keys outside the input pattern", () => {
    expect(parseS3Event(body(rec("runs/r-1/ingest/input_blocks.json")))).toEqual([]);
    expect(parseS3Event(body(rec("runs/r-1/input/other.pdf")))).toEqual([]);
  });
  it("ignores test events, malformed JSON and odd shapes", () => {
    expect(parseS3Event(JSON.stringify({ Event: "s3:TestEvent", Bucket: "b" }))).toEqual([]);
    expect(parseS3Event("not json")).toEqual([]);
    expect(parseS3Event("null")).toEqual([]);
    expect(parseS3Event(JSON.stringify({ Records: [null, {}, { s3: {} }, { s3: { bucket: {}, object: { key: 5 } } }] }))).toEqual([]);
    expect(parseS3Event("%E0%A4%A")).toEqual([]);
    expect(parseS3Event(body(rec("%E0%A4%A")))).toEqual([]);
  });
  it("ignores non-ObjectCreated events but accepts a missing eventName", () => {
    expect(parseS3Event(body(rec("runs/r-1/input/guideline.pdf", "ObjectRemoved:Delete")))).toEqual([]);
    const noName = { s3: { bucket: { name: "b" }, object: { key: "runs/r-1/input/guideline.pdf" } } };
    expect(parseS3Event(body(noName))).toHaveLength(1);
  });
  it("returns several records", () => {
    const out = parseS3Event(
      body(rec("runs/a/input/guideline.pdf"), rec("junk"), rec("runs/b/input/guideline.pdf", "ObjectCreated:CompleteMultipartUpload")),
    );
    expect(out.map((o) => o.runId)).toEqual(["a", "b"]);
  });
});
