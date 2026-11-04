import { describe, expect, it } from "vitest";
import { routes } from "../../src/contract/routes.js";
import { CreateRunRequest } from "../../src/contract/schemas.js";

describe("routes", () => {
  it("builds concrete paths", () => {
    expect(routes.runs()).toBe("/runs");
    expect(routes.run("r1")).toBe("/runs/r1");
    expect(routes.versions("r1")).toBe("/runs/r1/versions");
    expect(routes.version("r1", 2)).toBe("/runs/r1/versions/2");
    expect(routes.comments("r1", 2)).toBe("/runs/r1/versions/2/comments");
    expect(routes.resume("r1")).toBe("/runs/r1/resume");
  });

  it("builds and proxies the clinician paths", () => {
    expect(routes.activity("r1")).toBe("/runs/r1/activity");
    expect(routes.activity("r1", 4)).toBe("/runs/r1/activity?after=4");
    expect(routes.chat("r1")).toBe("/runs/r1/chat");
    expect(routes.flow("r1", 2)).toBe("/runs/r1/versions/2/flow");
    expect(routes.editsPreview("r1", 2)).toBe("/runs/r1/versions/2/edits/preview");
    expect(routes.edits("r1", 2)).toBe("/runs/r1/versions/2/edits");
    expect(routes.diff("r1", 1, 2)).toBe("/runs/r1/versions/1/diff/2");
    expect(routes.change("r1", 2)).toBe("/runs/r1/versions/2/change");
    expect(routes.restore("r1", 2)).toBe("/runs/r1/versions/2/restore");
    const p = routes.pattern;
    expect(routes.proxiable).toEqual(expect.arrayContaining([p.activity, p.chat, p.flow, p.editsPreview, p.edits, p.diff, p.change, p.restore]));
  });

  it("exposes Fastify patterns", () => {
    expect(routes.pattern.runs).toBe("/runs");
    expect(routes.pattern.run).toBe("/runs/:id");
    expect(routes.pattern.versions).toBe("/runs/:id/versions");
    expect(routes.pattern.version).toBe("/runs/:id/versions/:n");
    expect(routes.pattern.comments).toBe("/runs/:id/versions/:n/comments");
    expect(routes.pattern.resume).toBe("/runs/:id/resume");
  });
});

describe("CreateRunRequest", () => {
  it("accepts a missing pages field", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf" }).success).toBe(true);
  });
  it("accepts valid pages", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf", pages: [1, 3] }).success).toBe(true);
  });
  it("rejects page 0", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf", pages: [0] }).success).toBe(false);
  });
  it("rejects an empty pages array", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf", pages: [] }).success).toBe(false);
  });
  it("rejects duplicate pages", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf", pages: [1, 1] }).success).toBe(false);
  });
});
