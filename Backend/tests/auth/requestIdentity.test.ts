import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { IdentityResolver } from "../../src/auth/identity.js";
import { actorId, enforceRequestIdentity } from "../../src/auth/requestIdentity.js";
import { routes } from "../../src/contract/routes.js";

const resolve: IdentityResolver = async (h) =>
  h === "Bearer ana" ? { userId: "sub-ana", email: "Ana@Example.org", roles: ["clinician"] }
  : h === "Bearer ivan" ? { userId: "sub-ivan", email: "ivan+it@example.org", roles: ["it"] }
  : null;

function app() {
  const a = Fastify();
  enforceRequestIdentity(a, resolve);
  const echo = async (req: { body: unknown; params: unknown }) => ({ body: req.body, params: req.params });
  a.post("/versions", echo);
  a.post("/runs/:id/versions/:n/signatures/:role", echo);
  a.post(routes.pattern.events, echo);
  a.post("/plain", echo);
  return a;
}
const post = (url: string, payload: unknown, token?: string) =>
  app().inject({ method: "POST", url, payload: payload as object, ...(token ? { headers: { authorization: "Bearer " + token } } : {}) });

describe("actorId", () => {
  it("uses the email when it is a valid user id, else the Cognito sub", () => {
    expect(actorId({ userId: "sub-ana", email: "Ana@Example.org", roles: [] })).toBe("ana@example.org");
    expect(actorId({ userId: "SUB-ivan", email: "ivan+it@example.org", roles: [] })).toBe("sub-ivan");
    expect(actorId({ userId: "sub-x", roles: [] })).toBe("sub-x");
  });
});

describe("enforceRequestIdentity", () => {
  it("overwrites author and userId with the signed-in person", async () => {
    const r = await post("/versions", { author: "clinician", userId: "clinician", authorRole: "clinician", body: {} }, "ana");
    expect(r.statusCode).toBe(200);
    expect(r.json().body).toMatchObject({ author: "ana@example.org", userId: "ana@example.org", authorRole: "clinician" });
  });
  it("needs a valid token when the body names a person", async () => {
    expect((await post("/versions", { author: "clinician" })).statusCode).toBe(401);
    expect((await post("/versions", { author: "clinician" }, "mallory")).statusCode).toBe(401);
  });
  it("refuses a role the person does not have, in the body or the signature path", async () => {
    const body = await post("/versions", { author: "x", authorRole: "clinician" }, "ivan");
    expect(body.statusCode).toBe(403);
    expect(body.json()).toMatchObject({ error: "role_not_allowed" });
    expect((await post("/runs/r1/versions/2/signatures/clinician", { role: "clinician", userId: "x", modelSha: "s" }, "ivan")).statusCode).toBe(403);
    const ok = await post("/runs/r1/versions/2/signatures/clinician", { role: "clinician", userId: "x", modelSha: "s" }, "ana");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().body.userId).toBe("ana@example.org");
  });
  it("leaves requests that name no person and claim no role alone, and never touches internal routes", async () => {
    expect((await post("/plain", { text: "hi" })).statusCode).toBe(200);
    const ev = await post(routes.pattern.events, { userId: "clinician", source: "aws.events" });
    expect(ev.statusCode).toBe(200);
    expect(ev.json().body.userId).toBe("clinician");
  });
});
