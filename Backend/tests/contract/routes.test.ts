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
  it("rejects duplicate pages", () => {
    expect(CreateRunRequest.safeParse({ filename: "a.pdf", pages: [1, 1] }).success).toBe(false);
  });
});
