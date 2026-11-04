/**
 * Signer identity (BRD section 4: two different people sign; DEC-019, DEC-020).
 *
 * A userId is compared only in its normalised form, everywhere (Signoff, rules.ts, MemoryStore,
 * DynamoStore): Unicode NFKC (fullwidth and compatibility forms fold to plain letters), invisible
 * format characters removed (zero-width space, joiners, BOM, bidi marks), surrounding white space
 * trimmed, lower case. What is left must be 1 to 128 characters of [a-z0-9._@-], starting with a
 * letter or digit. So "Alice", " alice", "alice<zero-width space>" and fullwidth "ａｌｉｃｅ" are one person.
 *
 * AUTH SEAM (DEC-015, not built): until Cognito exists the userId is whatever the request body says,
 * so this only stops accidental or cosmetic variants, not a person who types another name. With
 * Cognito, bind userId to the verified token's `sub` (a UUID, already in this form) and stop reading
 * it from the body; normaliseUserId stays as the single comparison rule.
 */

export const USER_ID_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,127}$/;

export class InvalidUserId extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUserId";
  }
}

/** Unicode format characters (Cf: zero-width space/joiners, BOM, bidi controls, soft hyphen...). */
const FORMAT_CHARS = /\p{Cf}/gu;

/** The normalised userId, or InvalidUserId when nothing usable is left. */
export function normaliseUserId(raw: string): string {
  if (typeof raw !== "string") throw new InvalidUserId("userId must be text");
  const v = raw.normalize("NFKC").replace(FORMAT_CHARS, "").trim().toLowerCase().normalize("NFKC");
  if (!USER_ID_PATTERN.test(v)) {
    throw new InvalidUserId("userId must be 1 to 128 letters, digits or . _ @ - (no spaces), starting with a letter or digit");
  }
  return v;
}

/** True when both name the same person after normalisation. An id that cannot be normalised never matches. */
export function sameUser(a: string, b: string): boolean {
  try {
    return normaliseUserId(a) === normaliseUserId(b);
  } catch {
    // Compare the raw forms as a last resort so a malformed stored id can never look like a different person.
    return a.normalize("NFKC").replace(FORMAT_CHARS, "").trim().toLowerCase() === b.normalize("NFKC").replace(FORMAT_CHARS, "").trim().toLowerCase();
  }
}

/**
 * The officer agent's identity (DEC-024). The program officer's signature slot is filled by the officer agent,
 * never by a person: rules.ts accepts only this id as the first signature, both stores condition the first
 * write on it, and the HTTP API refuses it in any request body, so only in-process code can use it.
 */
export const OFFICER_AGENT_ID = "officer-agent@system";

/** True when the id (after normalisation) is the officer agent's. Malformed ids are never reserved. */
export function isReservedUserId(raw: string): boolean {
  try {
    return normaliseUserId(raw) === OFFICER_AGENT_ID;
  } catch {
    return false;
  }
}
