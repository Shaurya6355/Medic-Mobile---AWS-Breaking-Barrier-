import { describe, expect, it } from "vitest";
import { routes } from "../../src/contract/routes.js";
import { InvocationRequest, InvocationResponse, PingResponse } from "../../src/contract/schemas.js";

describe("agentcore routes", () => {
  it("exposes ping and invocations", () => {
    expect(routes.ping()).toBe("/ping");
    expect(routes.invocations()).toBe("/invocations");
    expect(routes.pattern.ping).toBe("/ping");
    expect(routes.pattern.invocations).toBe("/invocations");
  });
  it("lists the proxiable patterns without ping and invocations", () => {
    expect(routes.proxiable).toContain(routes.pattern.runs);
    expect(routes.proxiable).toContain(routes.pattern.resume);
    expect(routes.proxiable).not.toContain(routes.pattern.ping);
    expect(routes.proxiable).not.toContain(routes.pattern.invocations);
  });
});

describe("PingResponse", () => {
  it("accepts both statuses", () => {
    expect(PingResponse.safeParse({ status: "Healthy" }).success).toBe(true);
    expect(PingResponse.safeParse({ status: "HealthyBusy", time_of_last_update: 5 }).success).toBe(true);
  });
  it("rejects other statuses", () => {
    expect(PingResponse.safeParse({ status: "Busy" }).success).toBe(false);
  });
});

describe("InvocationRequest", () => {
  it("accepts uploaded, resume_all and http", () => {
    expect(InvocationRequest.safeParse({ action: "uploaded", runId: "abc-123" }).success).toBe(true);
    expect(InvocationRequest.safeParse({ action: "resume_all" }).success).toBe(true);
    expect(InvocationRequest.safeParse({ action: "http", method: "GET", path: "/runs" }).success).toBe(true);
    expect(
      InvocationRequest.safeParse({ action: "http", method: "POST", path: "/runs", headers: { a: "b" }, body: "{}" }).success,
    ).toBe(true);
  });
  it.each([
    [{ action: "uploaded", runId: "../x" }],
    [{ action: "uploaded", runId: "" }],
    [{ action: "uploaded", runId: "a".repeat(129) }],
    [{ action: "uploaded" }],
    [{ action: "nope" }],
    [{ action: "http", method: "TRACE", path: "/runs" }],
    [{ action: "http", method: "GET", path: "runs" }],
    [{ action: "http", method: "GET", path: "/" + "a".repeat(2048) }],
    [{ action: "http", method: "GET", path: "/runs", body: "a".repeat(1024 * 1024 + 1) }],
    [{ action: "http", method: "GET", path: "/runs", headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`h${i}`, "v"])) }],
    [{ action: "http", method: "GET", path: "/runs", headers: { a: "v".repeat(8193) } }],
    [null],
  ])("rejects %j", (v) => {
    expect(InvocationRequest.safeParse(v).success).toBe(false);
  });
});

describe("InvocationResponse", () => {
  it("accepts both variants", () => {
    expect(InvocationResponse.safeParse({ accepted: true }).success).toBe(true);
    expect(InvocationResponse.safeParse({ statusCode: 200, headers: {}, body: "" }).success).toBe(true);
    expect(InvocationResponse.safeParse({ statusCode: "x" }).success).toBe(false);
  });
});
