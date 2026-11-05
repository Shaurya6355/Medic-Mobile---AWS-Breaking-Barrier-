/* Sign-in (DEC-015): Cognito's hosted sign-in page, authorization code flow with PKCE (no client secret in the
   browser, no SDK). On when VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID are set at build time (the
   OrchestratorLambdaStack outputs AUTHDOMAIN and USERPOOLCLIENTID); otherwise the app runs without sign-in.
   The ID token lives in sessionStorage (cleared when the tab closes) and goes to the API as a Bearer token. */
import type { Role } from "./domain/types";

const DOMAIN = (import.meta.env.VITE_COGNITO_DOMAIN as string | undefined)?.replace(/\/+$/, "") || undefined;
const CLIENT_ID = (import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined) || undefined;
/** True when the app needs a sign-in. */
export const AUTH = !!(DOMAIN && CLIENT_ID);

const KEY = "auth.idToken", PKCE = "auth.pkce";
const redirectUri = () => window.location.origin + "/";

export interface User { email: string; roles: Role[]; groups: string[] }
/** The app's screens per Cognito group. program_officer is the AI agent's role in the review, so it has no screen. */
const SCREEN_ROLE: Record<string, Role> = { clinician: "clinician", it: "it" };

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function claims(token: string): Record<string, unknown> | null {
  try {
    const p = token.split(".")[1];
    const bin = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* private mode */ } };

/** The ID token while it is valid for at least another minute; otherwise null. */
export function idToken(): string | null {
  const t = read(KEY);
  if (!t) return null;
  const exp = Number(claims(t)?.exp ?? 0);
  if (!exp || exp * 1000 < Date.now() + 60_000) { write(KEY, null); return null; }
  return t;
}

export function currentUser(): User | null {
  const t = idToken();
  const c = t ? claims(t) : null;
  if (!c) return null;
  const groups = Array.isArray(c["cognito:groups"]) ? (c["cognito:groups"] as unknown[]).filter((g): g is string => typeof g === "string") : [];
  const roles = [...new Set(groups.map(g => SCREEN_ROLE[g]).filter((r): r is Role => !!r))];
  return { email: typeof c.email === "string" ? c.email : String(c.sub ?? ""), roles, groups };
}

/** Goes to the hosted sign-in page; it comes back to this origin with ?code=&state=. */
export async function signIn(): Promise<void> {
  if (!AUTH) return;
  const verifier = random(48), state = random(16);
  write(PKCE, JSON.stringify({ verifier, state, back: window.location.pathname }));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID!, redirect_uri: redirectUri(), scope: "openid email profile", state, code_challenge_method: "S256", code_challenge: challenge });
  window.location.assign(DOMAIN + "/oauth2/authorize?" + q.toString());
}

/** On the way back from the sign-in page: trade the code for tokens. Returns the path to go back to, if any. */
export async function completeSignIn(): Promise<string | null> {
  if (!AUTH) return null;
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code) return null;
  const saved = (() => { try { return JSON.parse(read(PKCE) || "null") as { verifier: string; state: string; back: string } | null; } catch { return null; } })();
  write(PKCE, null);
  window.history.replaceState(null, "", url.pathname);
  if (!saved || saved.state !== state) throw new Error("Sign-in did not match this browser tab. Please sign in again.");
  const r = await fetch(DOMAIN + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID!, code, redirect_uri: redirectUri(), code_verifier: saved.verifier }),
  });
  if (!r.ok) throw new Error("Sign-in failed (" + r.status + "). Please try again.");
  const tok = (await r.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error("Sign-in returned no ID token.");
  write(KEY, tok.id_token);
  return saved.back && saved.back !== "/" ? saved.back : null;
}

export function signOut(): void {
  write(KEY, null);
  if (!AUTH) return;
  const q = new URLSearchParams({ client_id: CLIENT_ID!, logout_uri: redirectUri() });
  window.location.assign(DOMAIN + "/logout?" + q.toString());
}
