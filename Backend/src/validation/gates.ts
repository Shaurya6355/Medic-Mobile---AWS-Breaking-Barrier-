import { render } from "./messages.js";
import type { Audience, CheckContext, Finding } from "./finding.js";

/**
 * Who may do what next, from the findings. Rules (BRD AR-03, AR-08):
 * - the program officer signs first; a blocking finding for the program officer stops that signature and so everything after it;
 * - a blocking finding for the clinician stops only the clinician's signature (the officer may sign first);
 * - any blocking finding, or a claim that is not proven, stops the build.
 */

export type GateInput = { findings: readonly Finding[]; claim: "PROVEN" | "NOT_PROVEN"; claimText: string };

export type Gates = {
  canOfficerSign: boolean;
  canClinicianSign: boolean;
  canCompile: boolean;
  blockers: { officer: Finding[]; clinician: Finding[]; compile: Finding[] };
  /** Plain words: who can do what next, and why not. */
  summary: string;
};

const LABELS: Record<string, readonly [string, string]> = {
  OPEN_QUESTION: ["unanswered open question", "unanswered open questions"],
  OPEN_QUESTION_NO_RESOLUTION: ["open question marked answered with no answer written", "open questions marked answered with no answer written"],
  OPEN_QUESTION_TRIVIAL_RESOLUTION: ["open question whose answer says nothing", "open questions whose answers say nothing"],
  OPEN_QUESTION_REMOVED: ["open question removed instead of answered", "open questions removed instead of answered"],
  OPEN_QUESTION_REROUTED: ["open question sent to someone else", "open questions sent to someone else"],
  OPEN_QUESTION_WRONG_RESOLVER: ["open question answered by the wrong person", "open questions answered by the wrong person"],
  OPEN_QUESTION_CLINICIAN_NOT_RECORDED: ["clinician answer without the clinician's name and change note", "clinician answers without the clinician's name and change note"],
  GUIDELINE_FILE_MISMATCH: ["different copy of the guideline than the one uploaded", "different copies of the guideline than the one uploaded"],
  SEVERITY_INVERSION: ["urgent result hidden by a less urgent one", "urgent results hidden by less urgent ones"],
  UNGROUNDED_NUMBER: ["number not backed by a quote of the booklet", "numbers not backed by a quote of the booklet"],
  UNIT_MISMATCH: ["number with the wrong unit", "numbers with the wrong unit"],
  HALLUCINATED_CITATION: ["quote not found on the booklet page", "quotes not found on the booklet page"],
  EMPTY_QUOTE: ["empty quote", "empty quotes"],
  SOURCE_PAGE_MISSING: ["citation of a page the booklet does not have", "citations of pages the booklet does not have"],
  SOURCE_DOCUMENT_MISSING: ["missing booklet text", "missing booklet text"],
  DANGER_SIGN_NOT_MODELLED: ["danger sign missing from the draft", "danger signs missing from the draft"],
  INCLUSIVITY_MISMATCH: ["cut-off that treats the exact number differently from the booklet", "cut-offs that treat the exact number differently from the booklet"],
  GOLDEN_MISMATCH: ["test case that gets another result", "test cases that get another result"],
  GOLDEN_INVALID: ["test case that cannot be run", "test cases that cannot be run"],
  COMPILE_NOT_READY: ["missing form setting", "missing form settings"],
  FOLLOWUP_MISSING_OUTCOME: ["referral without a follow-up", "referrals without a follow-up"],
  FOLLOWUP_INVALID_DAYS: ["follow-up with a negative number of days", "follow-ups with a negative number of days"],
  CLINICAL_TEXT_MISSING: ["result without instructions", "results without instructions"],
  CLINICAL_TEXT_UNSOURCED: ["referral whose instructions are not from the booklet", "referrals whose instructions are not from the booklet"],
  RESERVED_FIELD_NAME: ["name the form keeps for itself", "names the form keeps for itself"],
  INVALID_FIELD_NAME: ["name that cannot be used in the form", "names that cannot be used in the form"],
  FIELD_RENAMED: ["renamed or removed question that existing reports use", "renamed or removed questions that existing reports use"],
  OUTSIDE_AGE_BANDS_MISMATCH: ["rule for children outside the covered ages that leaves some of them out", "rules for children outside the covered ages that leave some of them out"],
  UNCOVERED_ANSWERS: ["group of children left without a result", "groups of children left without a result"],
  TABLE_NOT_CLOSED: ["list of rules without a catch-all", "lists of rules without a catch-all"],
  CHECK_CRASHED: ["check that stopped before it finished", "checks that stopped before they finished"],
  SCHEMA_INVALID: ["problem in the form of the draft", "problems in the form of the draft"],
};

function tally(findings: readonly Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
  const parts: string[] = [];
  let other = 0;
  for (const code of [...counts.keys()].sort()) {
    const n = counts.get(code) as number;
    const l = LABELS[code];
    if (l === undefined) other += n;
    else parts.push(`${n} ${n === 1 ? l[0] : l[1]}`);
  }
  if (other > 0) parts.push(`${other} other blocking ${other === 1 ? "item" : "items"}`);
  return parts.join("; ");
}

export function gates(result: GateInput, _ctx?: CheckContext): Gates {
  const blocking = result.findings.filter((f) => f.severity === "blocking");
  const officer = blocking.filter((f) => f.decidedBy === "program_officer");
  const clinician = blocking.filter((f) => f.decidedBy === "clinician");
  const notProven = result.claim !== "PROVEN";
  const compile = [...blocking];

  const canOfficerSign = officer.length === 0;
  const canClinicianSign = canOfficerSign && clinician.length === 0;
  const canCompile = blocking.length === 0 && !notProven;

  const sentences: string[] = [];
  sentences.push(canOfficerSign ? "The program officer can sign now." : `The program officer cannot sign yet. Still to settle: ${tally(officer)}.`);
  if (canClinicianSign) sentences.push("The clinician can sign once the program officer has signed.");
  else if (!canOfficerSign) {
    sentences.push(
      `The clinician cannot sign yet: this waits for the program officer's signature${clinician.length > 0 ? `, and these are for the clinician: ${tally(clinician)}` : ""}.`,
    );
  } else sentences.push(`The clinician cannot sign yet. Still to settle: ${tally(clinician)}.`);
  if (canCompile) sentences.push("The form can be built once both have signed.");
  else {
    const why: string[] = [];
    if (blocking.length > 0) why.push(`${blocking.length} ${blocking.length === 1 ? "item still blocks" : "items still block"}`);
    if (notProven) why.push("it is not proven that every combination of answers gets a result");
    sentences.push(`The form cannot be built yet: ${why.join(", and ")}.`);
  }
  return { canOfficerSign, canClinicianSign, canCompile, blockers: { officer, clinician, compile }, summary: sentences.join(" ") };
}

export type RoleFinding = Finding & { /** This role is the one that decides it. */ yours: boolean };
export type FindingGroup = { severity: "blocking" | "warning" | "info"; findings: RoleFinding[] };

const SEVERITIES = ["blocking", "warning", "info"] as const;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What one role sees: the findings addressed to it, grouped from blocking to information, the ones it decides first,
 * each with the wording written for that role. The finding's id, code and the rest stay as they are.
 */
export function findingsFor(findings: readonly Finding[], role: Audience): FindingGroup[] {
  const groups: FindingGroup[] = [];
  for (const severity of SEVERITIES) {
    const list = findings
      .filter((f) => f.severity === severity && f.audience.includes(role))
      .map((f): RoleFinding => ({ ...f, message: render(f.code, f.params, role), yours: f.decidedBy === role }))
      .sort((a, b) => Number(b.yours) - Number(a.yours) || cmp(a.check, b.check) || cmp(a.id, b.id));
    if (list.length > 0) groups.push({ severity, findings: list });
  }
  return groups;
}
