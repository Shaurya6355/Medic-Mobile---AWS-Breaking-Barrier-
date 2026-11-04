import { describe, expect, it } from "vitest";
import { DEFAULT_BODY_LIMIT_BYTES, buildServer } from "../src/server.js";
import type { AgentFactory } from "../src/agent.js";

const body = { modelId: "m", system: "s", maxTokens: 10, content: [{ type: "text", text: "SECRET-PATIENT-DATA" }] };
const ok: AgentFactory = () => ({
  async invoke() {
    return { toString: () => "out", metrics: { accumulatedUsage: { inputTokens: 1, outputTokens: 2 } } } as never;
  },
});
const failing = (e: unknown): AgentFactory => () => ({
  async invoke() {
    throw e;
  },
});

describe("POST /invocations", () => {
  it("returns 200 with an ok envelope carrying raw and usage", async () => {
    const app = buildServer({ createAgent: ok });
    const res = await app.inject({ method: "POST", url: "/invocations", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, raw: "out", usage: { inputTokens: 1, outputTokens: 2, modelId: "m" } });
  });
  it("answers 200 invalid_request for schema failures, naming paths only", async () => {
    const app = buildServer({ createAgent: ok });
    const res = await app.inject({ method: "POST", url: "/invocations", payload: { ...body, maxTokens: 0, system: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().kind).toBe("invalid_request");
    expect(res.json().message).toMatch(/maxTokens/);
    expect(res.json().message.length).toBeLessThanOrEqual(300);
  });
  it("answers 200 invalid_request for malformed JSON", async () => {
    const app = buildServer({ createAgent: ok });
    const res = await app.inject({ method: "POST", url: "/invocations", payload: "{bad", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, kind: "invalid_request" });
  });
  it("answers 200 invalid_request for invalid base64", async () => {
    const app = buildServer({ createAgent: ok });
    const res = await app.inject({
      method: "POST",
      url: "/invocations",
      payload: { ...body, content: [{ type: "image", format: "png", base64: "***" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, kind: "invalid_request" });
  });
  it("answers 200 transient for throttling and similar errors", async () => {
    const app = buildServer({ createAgent: failing(Object.assign(new Error("slow down"), { name: "ThrottlingException" })) });
    const res = await app.inject({ method: "POST", url: "/invocations", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, kind: "transient", message: "slow down" });
  });
  it("answers 200 permanent for other errors, bounded and without request content", async () => {
    const app = buildServer({ createAgent: failing(new Error("x".repeat(5000))) });
    const res = await app.inject({ method: "POST", url: "/invocations", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().kind).toBe("permanent");
    expect(res.json().message.length).toBeLessThanOrEqual(300);
    expect(res.body).not.toContain("SECRET-PATIENT-DATA");
  });
  it("answers 200 invalid_request for bodies over the configured limit", async () => {
    const app = buildServer({ createAgent: ok, bodyLimitBytes: 200 });
    const res = await app.inject({
      method: "POST",
      url: "/invocations",
      payload: { ...body, content: [{ type: "text", text: "y".repeat(1000) }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, kind: "invalid_request" });
    expect(res.json().message).toMatch(/too large|limit/i);
  });
  it("defaults the body limit to 90 MiB", () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(90 * 1024 * 1024);
  });
});

describe("GET /ping", () => {
  it("reports Healthy, then HealthyBusy while in flight, and stamps time only on change", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let t = 1000;
    const slow: AgentFactory = () => ({
      async invoke() {
        await gate;
        return { toString: () => "o" } as never;
      },
    });
    const app = buildServer({ createAgent: slow, now: () => t });
    const p0 = (await app.inject({ method: "GET", url: "/ping" })).json();
    expect(p0.status).toBe("Healthy");
    expect(p0.time_of_last_update).toBeUndefined();

    t = 2000;
    const inflight = app.inject({ method: "POST", url: "/invocations", payload: body });
    await new Promise((r) => setTimeout(r, 20));
    t = 2500;
    const p1 = (await app.inject({ method: "GET", url: "/ping" })).json();
    expect(p1).toEqual({ status: "HealthyBusy", time_of_last_update: 2000 });
    t = 3000;
    const p1b = (await app.inject({ method: "GET", url: "/ping" })).json();
    expect(p1b.time_of_last_update).toBe(2000);

    t = 4000;
    release();
    await inflight;
    const p2 = (await app.inject({ method: "GET", url: "/ping" })).json();
    expect(p2).toEqual({ status: "Healthy", time_of_last_update: 4000 });
  });
  it("returns to Healthy after a failed request", async () => {
    const app = buildServer({ createAgent: failing(new Error("x")) });
    await app.inject({ method: "POST", url: "/invocations", payload: body });
    expect((await app.inject({ method: "GET", url: "/ping" })).json().status).toBe("Healthy");
  });
});
