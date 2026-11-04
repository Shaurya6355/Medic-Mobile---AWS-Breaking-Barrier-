/* The check pipeline the draft goes through, in order:
     1 Schema check (gate)  2a Quote check  2b Number check  3 Logic checks (sample patients)   <- program officer fixes
     4 Golden cases  5 Cross check (draft A vs draft B)                                         <- clinician looks
   Every stage is deterministic. Both roles see every stage; each stage lists its errors with the step they are on. */
import { analyze, applyPatch, item, crossCheck, literals, numberResults, quoteResults, type ItemId, type Spec } from "../../../shared/pathway/index.ts";
import { GOLDEN } from "./data";
import { classify, describeP, golden, grid, itemLabel, outName } from "./logic";
import type { Check, CheckKey, Evidence } from "./types";

export type StageStatus = "pass" | "warn" | "fail" | "skipped" | "missing";
export interface Part { name: string; ok: boolean; text: string }
export interface Stage {
  key: CheckKey; n: string; name: string; asks: string; owner: "po" | "clinician";
  status: StageStatus; summary: string; issues: Check[]; parts?: Part[]; uses?: string;
}

export const STAGES: { key: CheckKey; n: string; name: string; asks: string; owner: "po" | "clinician" }[] = [
  { key: "schema", n: "1", name: "Schema check", asks: "Gate: does the draft have every box, with valid values?", owner: "po" },
  { key: "quote", n: "2a", name: "Quote check", asks: "Does each quoted passage exist in the guideline, on the page it cites?", owner: "po" },
  { key: "number", n: "2b", name: "Number check", asks: "Does each number in a rule match the quote it cites?", owner: "po" },
  { key: "logic", n: "3", name: "Logic checks", asks: "Run generated sample patients through the rules: four checks.", owner: "po" },
  { key: "golden", n: "4", name: "Golden cases", asks: "Do the hand-made test cases get the expected classification?", owner: "clinician" },
  { key: "cross", n: "5", name: "Cross check", asks: "Do two independent drafts (A and B) agree?", owner: "clinician" },
];
export const stageName = (k: CheckKey) => { const s = STAGES.find(x => x.key === k)!; return s.n + " " + s.name; };

const statusOf = (issues: Check[]): StageStatus => (issues.some(c => c.sev === "blocking") ? "fail" : issues.length ? "warn" : "pass");
const short = (q: string) => (q.length > 90 ? q.slice(0, 87) + "…" : q);

function logic(m: Spec): Pick<Stage, "issues" | "parts" | "summary"> {
  const ps = grid(m), res = ps.map(p => classify(m, p));
  const issues: Check[] = [];
  const fired = new Set(res.map(r => r.rule));
  const unreached = m.rules.filter(r => r.when !== "otherwise" && !fired.has(r.id));
  unreached.forEach(r => issues.push({ kind: "logic", sev: "blocking", id: item.rule(r.id), text: "No sample patient reaches this rule: an earlier rule always matches first, or the condition can't be true." }));
  const none = ps.filter((_, i) => res[i].out === null);
  if (none.length) issues.push({ kind: "logic", sev: "blocking", id: item.scope, text: none.length + " sample patients get no classification, e.g. " + describeP(m, none[0]) + "." });
  const used = new Set(res.map(r => r.out));
  const unused = m.outcomes.filter(o => !used.has(o.id));
  unused.forEach(o => issues.push({ kind: "logic", sev: "warning", id: item.out(o.id), text: "No sample patient ends in this classification." }));
  const base = res.map(r => r.out);
  const lits = literals(m);
  // A threshold is caught when moving it by one, either way, changes some sample patient's classification.
  const caught = (l: (typeof lits)[number], d: number) => {
    const mu = applyPatch(m, { op: "set", path: l.path, value: l.leaf.value! + d });
    return ps.some((p, i) => classify(mu, p).out !== base[i]);
  };
  const survivors = lits.filter(l => !caught(l, 1) && !caught(l, -1));
  survivors.forEach(l => issues.push({ kind: "logic", sev: "warning", id: l.item, text: "Moving " + l.leaf.field + " " + l.leaf.value + " by one either way changes no sample patient's classification: this threshold has no effect." }));
  return {
    summary: ps.length + " sample patients generated from the boundary values",
    issues,
    parts: [
      { name: "Every rule can be reached", ok: !unreached.length, text: unreached.length ? unreached.map(r => r.id).join(", ") + " never reached" : m.rules.length + " of " + m.rules.length + " rules reached" },
      { name: "Every patient gets a classification", ok: !none.length, text: none.length ? none.length + " patients with none" : ps.length + " of " + ps.length + " classified" },
      { name: "Every classification can be reached", ok: !unused.length, text: unused.length ? unused.length + " never reached" : m.outcomes.length + " of " + m.outcomes.length + " used" },
      { name: "Every threshold changes an outcome", ok: !survivors.length, text: (lits.length - survivors.length) + " of " + lits.length + " threshold changes caught" },
    ],
  };
}

function cross(m: Spec, b: Spec): Pick<Stage, "issues" | "summary"> {
  const r = crossCheck(m, b, [grid(m), grid(b)]);
  const issues: Check[] = r.values.map(v => ({ kind: "cross" as const, sev: "warning" as const, id: v.item, text: "Threshold on " + v.field + ": draft A uses " + v.a + ", draft B uses " + v.b + "." }));
  const groups = new Map<string, typeof r.disagree>();
  r.disagree.forEach(d => { const k = [d.ruleA, d.a, d.b].join("|"); groups.set(k, [...(groups.get(k) ?? []), d]); });
  groups.forEach(ds => {
    const d = ds[0];
    issues.push({ kind: "cross", sev: "warning", id: d.ruleA ? item.rule(d.ruleA) : item.scope,
      text: ds.length + " sample patient" + (ds.length > 1 ? "s" : "") + ": draft A says " + outName(m, d.a) + ", draft B says " + outName(b, d.b) + ". E.g. " + describeP(m, d.answers) + "." });
  });
  return { summary: r.disagree.length ? "The drafts disagree on " + r.disagree.length + " of " + r.patients + " sample patients" : "The drafts agree on all " + r.patients + " sample patients", issues };
}

const cache = new WeakMap<Spec, { ev: Evidence; stages: Stage[] }>();
/** Every stage, in order. A failed schema check stops the rest. Cached per model and evidence. */
export function checkStages(m: Spec, ev: Evidence): Stage[] {
  const hit = cache.get(m);
  if (hit && hit.ev === ev) return hit.stages;
  const out: Stage[] = [];
  const add = (key: CheckKey, s: Omit<Stage, "key" | "n" | "name" | "asks" | "owner" | "status"> & { status?: StageStatus }) => {
    const info = STAGES.find(x => x.key === key)!;
    out.push({ ...info, ...s, status: s.status ?? statusOf(s.issues) });
  };

  const schema: Check[] = analyze(m).map(d => ({ kind: "schema", sev: d.level === "error" ? "blocking" : "warning", id: d.item, text: d.message }));
  const errs = schema.filter(c => c.sev === "blocking").length;
  add("schema", { issues: schema, summary: errs ? errs + " error" + (errs > 1 ? "s" : "") + ": the later checks wait for these" : "Every box present and valid" + (schema.length ? ", " + schema.length + " warning" + (schema.length > 1 ? "s" : "") : "") });
  if (errs) {
    STAGES.slice(1).forEach(s => add(s.key, { status: "skipped", issues: [], summary: "Not run: fix the schema check first." }));
    cache.set(m, { ev, stages: out });
    return out;
  }

  if (!ev.pages) add("quote", { status: "missing", issues: [], summary: "Needs the guideline text, which is not loaded for this draft." });
  else {
    const rs = quoteResults(m, ev.pages);
    const issues: Check[] = [];
    rs.forEach(r => {
      if (!r.found) issues.push({ kind: "quote", sev: "blocking", id: r.item, text: "Not found in the guideline: “" + short(r.source.quote) + "” (cites page " + r.source.page + ")." });
      else if (!r.onPage) issues.push({ kind: "quote", sev: "warning", id: r.item, text: "Found on page " + r.foundOn.join(", ") + ", but cites page " + r.source.page + ": “" + short(r.source.quote) + "”." });
    });
    add("quote", { issues, uses: ev.pagesFrom, summary: rs.filter(r => r.found).length + " of " + rs.length + " quotes found, " + rs.filter(r => r.onPage).length + " on the page they cite" });
  }

  const ns = numberResults(m);
  add("number", {
    issues: ns.filter(r => !r.ok).map(r => ({ kind: "number", sev: "warning", id: r.item, text: "The " + r.what + " value " + r.value + " is not in this step's quote: “" + short(r.quote) + "”." })),
    summary: ns.filter(r => r.ok).length + " of " + ns.length + " numbers match their quote (team-written steps skipped)",
  });

  add("logic", logic(m));

  const gc = GOLDEN[m.meta.pathway_id];
  if (!gc) add("golden", { status: "missing", issues: [], summary: "Needs a golden case file for " + m.meta.pathway_id + "." });
  else {
    const g = golden(m), bad = g.filter(x => !x.ok);
    add("golden", {
      uses: "Golden case file for " + m.meta.pathway_id + " (" + gc.length + " cases, sample)",
      summary: (g.length - bad.length) + " of " + g.length + " golden cases match",
      issues: bad.map(x => ({ kind: "golden", sev: "blocking", id: x.rule ? item.rule(x.rule) : item.scope, text: "Golden case " + x.id + " (" + describeP(m, x.a) + ") expected " + outName(m, x.exp) + ", got " + outName(m, x.got) + "." })),
    });
  }

  if (!ev.draftB) add("cross", { status: "missing", issues: [], summary: "Needs draft B, a second independent draft from the model pipeline." });
  else add("cross", { ...cross(m, ev.draftB), uses: ev.draftBFrom });

  cache.set(m, { ev, stages: out });
  return out;
}

/** Every issue from every stage, flat: what the gate, the rule table and the open items read. */
export const runChecks = (m: Spec, ev: Evidence): Check[] => checkStages(m, ev).flatMap(s => s.issues);
export const issueLabel = (c: Check) => (c.kind ? stageName(c.kind) + " · " : "") + itemLabel(c.id as ItemId);
