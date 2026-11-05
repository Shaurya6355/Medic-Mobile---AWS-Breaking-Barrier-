import type { FastifyInstance } from "fastify";
import { routes } from "../contract/routes.js";
import { USER_ID_PATTERN } from "../signoff/identity.js";
import type { Identity, IdentityResolver } from "./identity.js";

/**
 * Closes the AUTH SEAM (DEC-015) once sign-in is on: who acts, and in which role, comes from the verified token,
 * never from the request body.
 * - A POST whose body names a person (`author`, `userId`) needs a valid token, and those fields are overwritten
 *   with the signed-in person's id, so a version, signature, comment, revision or chat is recorded against them.
 * - Every role the request claims (`role`, `authorRole`, or `:role` in the signature path) must be one of the
 *   person's Cognito groups; otherwise 403. The sign-off rules then run unchanged on the rewritten body.
 * Internal routes (Lambda events, AgentCore invocations, ping) are never touched.
 */
const INTERNAL: readonly string[] = [routes.pattern.events, routes.pattern.invocations, routes.pattern.ping];

/** The id recorded for a person: their email when it is a valid user id, else their Cognito sub. */
export function actorId(who: Identity): string {
  const email = who.email?.trim().toLowerCase();
  return email !== undefined && USER_ID_PATTERN.test(email) ? email : who.userId.toLowerCase();
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function enforceRequestIdentity(app: FastifyInstance, resolve: IdentityResolver): void {
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST" || INTERNAL.includes(req.routeOptions.url ?? "")) return;
    const body = isObj(req.body) ? req.body : undefined;
    const pathRole = (req.params as { role?: unknown } | undefined)?.role;
    const claimed = [body?.["role"], body?.["authorRole"], pathRole].filter((r): r is string => typeof r === "string");
    const names = body !== undefined && ("author" in body || "userId" in body);
    if (!names && claimed.length === 0) return;

    const who = await resolve(req.headers.authorization);
    if (!who) return reply.code(401).send({ error: "unauthorized" });
    const missing = claimed.filter((r) => !(who.roles as readonly string[]).includes(r));
    if (missing.length > 0) {
      return reply.code(403).send({ error: "role_not_allowed", issues: [`your account is not in the ${[...new Set(missing)].join(", ")} group`] });
    }
    if (body !== undefined) {
      const id = actorId(who);
      if ("author" in body) body["author"] = id;
      if ("userId" in body) body["userId"] = id;
    }
  });
}
