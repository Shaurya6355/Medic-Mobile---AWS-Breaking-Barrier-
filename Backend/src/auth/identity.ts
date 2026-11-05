import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Run } from "../domain/types.js";

/**
 * Who is calling (DEC-015). A Cognito ID token, sent as "Authorization: Bearer <token>", is verified here
 * (signature, issuer, audience, expiry) even though API Gateway's JWT authorizer already checked it: the
 * backend never trusts an unverified identity, and container mode has no API Gateway in front of it.
 */
export const ROLES = ["program_officer", "clinician", "it"] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  /** Cognito `sub`: stable, unique, never reused. Stored on the runs this person creates. */
  userId: string;
  email?: string;
  /** The person's Cognito groups that are roles in this app. */
  roles: Role[];
}

/** Resolves the Authorization header to an identity, or null when it is missing or not valid. Never throws. */
export type IdentityResolver = (authorization: string | undefined) => Promise<Identity | null>;

const isRole = (g: unknown): g is Role => typeof g === "string" && (ROLES as readonly string[]).includes(g);

/** The identity in verified ID-token claims. Exported for tests. */
export function identityFromClaims(claims: Record<string, unknown>): Identity | null {
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub === "") return null;
  const groups = Array.isArray(claims["cognito:groups"]) ? (claims["cognito:groups"] as unknown[]) : [];
  const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;
  return { userId: sub, ...(email !== undefined ? { email } : {}), roles: [...new Set(groups.filter(isRole))] };
}

export function bearerToken(authorization: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return m ? m[1] : undefined;
}

export function cognitoResolver(opts: { userPoolId: string; clientId: string }): IdentityResolver {
  const verifier = CognitoJwtVerifier.create({ userPoolId: opts.userPoolId, tokenUse: "id", clientId: opts.clientId });
  return async (authorization) => {
    const token = bearerToken(authorization);
    if (token === undefined) return null;
    try {
      return identityFromClaims((await verifier.verify(token)) as unknown as Record<string, unknown>);
    } catch {
      return null;
    }
  };
}

/**
 * The runs a person sees in the run list, by role:
 * - everyone: the runs they uploaded, in any state;
 * - clinician: runs waiting for clinical review (awaiting_clinician);
 * - it: approved runs waiting for deploy (locked).
 * Runs with no recorded owner (created before sign-in existed) are shown to nobody.
 */
export function visibleRuns(runs: readonly Run[], who: Identity): Run[] {
  return runs.filter((r) => {
    if (r.createdBy === undefined) return false;
    if (r.createdBy === who.userId) return true;
    if (who.roles.includes("clinician") && r.state === "awaiting_clinician") return true;
    if (who.roles.includes("it") && r.state === "locked") return true;
    return false;
  });
}
