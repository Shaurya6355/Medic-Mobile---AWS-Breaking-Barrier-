import type { Condition, Model } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import {
  actionSubject,
  describeAction,
  describeDerived,
  describeFollowUp,
  describeQuestion,
  describeRule,
  describeScope,
  derivedSubject,
  followUpSubject,
  pagesText,
  questionSubject,
  ruleSubject,
  scopeSubject,
} from "../describe.js";
import { groundNumber, tokenize } from "../numbers.js";
import { clip, normalizeForQuote } from "../text.js";

const CHECK = "numberGrounding";
const CLINICIAN_FIRST: ("clinician" | "program_officer")[] = ["clinician", "program_officer"];

type Source = { page: number; quote: string };

type Use = {
  /** Id a clinician-approved deviation refers to. */
  owner: string;
  subjects: Subject[];
  item: string;
  value: number;
  unit?: string;
  usage: string;
  /** "twice" and "once" count as numbers (times per day). */
  freq?: boolean;
  /** Origin "team" and no source: the number claims no guideline backing. */
  team: boolean;
  sources: readonly Source[];
};

export type Cmp = { field: string; op: "at_least" | "less_than"; value: number };

/** Numeric literals compared in a condition. */
export function numericComparisons(root: Condition): Cmp[] {
  const out: Cmp[] = [];
  const stack: Condition[] = [root];
  while (stack.length > 0) {
    const c = stack.pop() as Condition;
    if ("field" in c) {
      if (c.op !== "is_yes") out.push({ field: c.field, op: c.op, value: c.value });
    } else {
      const kids = "all" in c ? c.all : c.any;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Condition);
    }
  }
  return out;
}

/** Numbers written in a short dose text such as "1 tablet", "10 tablets" or "1/2 tablet". */
export function numbersInText(text: string): { value: number; unit?: string }[] {
  const out: { value: number; unit?: string }[] = [];
  for (const m of text.matchAll(/(\d+)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)(?:\s*([a-zA-Z]+))?/g)) {
    if (m[1] !== undefined && m[2] !== undefined) {
      if (Number(m[2]) === 0) continue;
      const after = text.slice((m.index ?? 0) + m[0].length).match(/^\s*([a-zA-Z]+)/);
      out.push({ value: Number(m[1]) / Number(m[2]), ...(after?.[1] !== undefined ? { unit: after[1] } : {}) });
    } else if (m[3] !== undefined) {
      out.push({ value: Number(m[3]), ...(m[4] !== undefined ? { unit: m[4] } : {}) });
    }
  }
  return out;
}

export const phrase = (op: Cmp["op"], v: string): string => (op === "at_least" ? `${v} or more` : `less than ${v}`);

function collectUses(model: Model): { uses: Use[]; limits: string[]; limitSubjects: Subject[] } {
  const uses: Use[] = [];
  const questions = new Map(model.questions.map((q) => [q.id, q]));
  const isTeam = (origin: "guideline" | "team", sources: readonly Source[] | undefined): boolean =>
    origin === "team" && (sources === undefined || sources.length === 0);

  const addCondition = (
    owner: string,
    subject: Subject,
    item: string,
    when: Condition,
    origin: "guideline" | "team",
    sources: readonly Source[] | undefined,
  ): void => {
    for (const c of numericComparisons(when)) {
      const q = questions.get(c.field);
      const unit = q?.unit;
      const subjects: Subject[] = [subject];
      if (q !== undefined) subjects.push(questionSubject(q));
      uses.push({
        owner,
        subjects,
        item,
        value: c.value,
        ...(unit !== undefined ? { unit } : {}),
        usage: `${phrase(c.op, `${c.value}${unit !== undefined ? " " + unit.replace(/_/g, " ") : ""}`)} for "${clip(q?.label ?? c.field, 60)}"`,
        team: isTeam(origin, sources),
        sources: sources ?? [],
      });
    }
  };

  // scope ages
  for (const [v, word] of [[model.scope.age_months_min, "a lowest covered age of"], [model.scope.age_months_below, "an upper age limit of"]] as const) {
    uses.push({
      owner: "scope",
      subjects: [scopeSubject],
      item: describeScope(),
      value: v,
      unit: "months",
      usage: `${word} ${v} months`,
      team: false,
      sources: model.scope.source,
    });
  }

  const limits: string[] = [];
  const limitSubjects: Subject[] = [];
  for (const q of model.questions) {
    if (q.shown_when !== undefined) addCondition(q.id, questionSubject(q), describeQuestion(q), q.shown_when, q.origin, q.source);
    const c = q.constraint;
    if (c === undefined) continue;
    if (c.origin === "team") {
      const u = q.unit !== undefined ? ` ${q.unit.replace(/_/g, " ")}` : "";
      limits.push(`"${clip(q.label, 60)}": ${c.min} to ${c.max}${u}`);
      limitSubjects.push(questionSubject(q));
    } else {
      for (const [v, word] of [[c.min, "a lowest allowed entry of"], [c.max, "a highest allowed entry of"]] as const) {
        uses.push({
          owner: q.id,
          subjects: [questionSubject(q)],
          item: describeQuestion(q),
          value: v,
          ...(q.unit !== undefined ? { unit: q.unit } : {}),
          usage: `${word} ${v}`,
          team: isTeam(q.origin, q.source),
          sources: q.source ?? [],
        });
      }
    }
  }
  for (const d of model.derived) addCondition(d.id, derivedSubject(d), describeDerived(d), d.definition, d.origin, d.source);
  for (const r of model.rules) {
    if (r.when !== "otherwise") addCondition(r.id, ruleSubject(r), describeRule(model, r), r.when, r.origin, r.source);
  }

  for (const o of model.outcomes) {
    o.actions.forEach((a, i) => {
      const subject = actionSubject(o, i);
      const item = describeAction(o, i);
      const team = isTeam(a.origin, a.source);
      const sources = a.source ?? [];
      for (const d of a.dose_by_age ?? []) {
        const range = `${d.age_months_min} up to ${d.age_months_below} months`;
        for (const v of [d.age_months_min, d.age_months_below]) {
          if (v === 0) continue;
          uses.push({ owner: subject.id, subjects: [subject], item, value: v, unit: "months", usage: `an age limit of ${v} months in the dose table (${range})`, team, sources });
        }
        for (const [what, text] of [["a dose", d.dose], ["a total", d.total]] as const) {
          if (text === undefined) continue;
          for (const n of numbersInText(text)) {
            uses.push({
              owner: subject.id,
              subjects: [subject],
              item,
              value: n.value,
              ...(n.unit !== undefined ? { unit: n.unit } : {}),
              usage: `${what} of ${text} for age ${range}`,
              team,
              sources,
            });
          }
        }
      }
    });
    const f = o.follow_up;
    if (f !== null) {
      const subject = followUpSubject(o);
      const item = describeFollowUp(o);
      const team = isTeam(f.origin, f.source);
      const sources = f.source ?? [];
      if (f.due_in_days !== null && f.due_in_days !== 0) {
        uses.push({ owner: o.id, subjects: [subject], item, value: f.due_in_days, unit: "days", usage: `a follow-up due after ${f.due_in_days} days`, team, sources });
      }
      if (f.task_window_days_after_due !== null && f.task_window_days_after_due !== 0) {
        uses.push({
          owner: o.id,
          subjects: [subject],
          item,
          value: f.task_window_days_after_due,
          unit: "days",
          usage: `a follow-up task that stays open for ${f.task_window_days_after_due} days after it is due`,
          team,
          sources,
        });
      }
    }
  }
  return { uses, limits, limitSubjects };
}

/**
 * Every number that drives behaviour appears in a quote the item itself cites (it may cite several), next to a compatible unit.
 * The rest of the cited page does not count: when the page has the number, the finding names the passage to add as a quote.
 * Checked: numbers in conditions of derived values, rules and "shown when", the age range, dose and total
 * quantities and their age limits, follow-up days and the task window (null means "not given", not a number).
 * Not checked: entry limits the team chose (listed for the clinician), ids, severity.
 * Numbers in an item that is the team's own (origin "team", no source) are reported as team values to confirm.
 */
export function numberGrounding(ctx: CheckContext): Finding[] {
  const { model, document: doc } = ctx;
  const { uses, limits, limitSubjects } = collectUses(model);
  const out: Finding[] = [];

  // Team entry limits, one finding for the clinician (open question Q6 in the reference model).
  if (limits.length > 0) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "ENTRY_LIMIT_TEAM_CHOICE",
        severity: "info",
        audience: CLINICIAN_FIRST,
        decidedBy: "clinician",
        subjects: limitSubjects,
        params: { limits: limits.join("; ") },
        source: [],
      }),
    );
  }

  // Team-owned numbers: no guideline source is claimed, so the clinician confirms them.
  const teamByOwner = new Map<string, Use[]>();
  for (const u of uses) if (u.team) teamByOwner.set(u.owner, [...(teamByOwner.get(u.owner) ?? []), u]);
  for (const list of teamByOwner.values()) {
    const first = list[0] as Use;
    const subjects = [...new Map(list.flatMap((u) => u.subjects).map((s) => [s.kind + s.id, s])).values()];
    out.push(
      makeFinding({
        check: CHECK,
        code: "TEAM_VALUE",
        severity: "info",
        audience: CLINICIAN_FIRST,
        decidedBy: "clinician",
        subjects,
        params: { item: first.item, usage: [...new Set(list.map((u) => u.usage))].join("; ") },
        source: [],
      }),
    );
  }

  let needsDocument = false;
  for (const u of uses) {
    if (u.team) continue;
    if (doc === undefined) {
      needsDocument = true;
      continue;
    }
    const pages = [...new Set(u.sources.map((s) => s.page))];
    // Quote-only: the number must be written in a quote the item itself cites, not elsewhere on the page.
    const segments: string[] = u.sources.map((s) => s.quote);
    const g = groundNumber(tokenize(segments, u.freq === true), u.value, u.unit);
    if (g.status === "grounded") continue;

    const first = u.sources[0];
    // Where the cited page does carry the number: the passage the program officer can add as a further quote.
    let pageQuote = "";
    if (g.status !== "converted" && g.status !== "unit_mismatch") {
      const own = new Set(normalizeForQuote(u.sources.map((x) => x.quote).join(" ")).split(" ").filter((w) => w.length > 2));
      let best = -1;
      for (const p of pages) {
        for (const b of doc.pages.get(p) ?? []) {
          const gb = groundNumber(tokenize([b.text], u.freq === true), u.value, u.unit);
          if (gb.status !== "grounded" && gb.status !== "converted") continue;
          // Prefer the passage closest to what the item already quotes.
          const score = normalizeForQuote(b.text).split(" ").filter((w) => own.has(w)).length;
          if (score > best) {
            best = score;
            pageQuote = clip(b.text, 200);
          }
        }
      }
    }
    const base = {
      item: u.item,
      number: u.value,
      usage: u.usage,
      page: pagesText(pages),
      quote: clip(first?.quote ?? "", 200),
    };
    const source = u.sources.map((s) => ({ page: s.page, quote: s.quote }));
    const common = { check: CHECK, subjects: u.subjects, source };

    if (g.status === "converted") {
      out.push(
        makeFinding({
          ...common,
          code: "NUMBER_UNIT_CONVERTED",
          severity: "info",
          audience: CLINICIAN_FIRST,
          decidedBy: "clinician",
          params: { ...base, derivation: g.derivation, textValue: g.textValue, textUnit: g.textUnit },
        }),
      );
    } else if (g.status === "unit_mismatch") {
      out.push(
        makeFinding({
          ...common,
          code: "UNIT_MISMATCH",
          severity: "blocking",
          audience: CLINICIAN_FIRST,
          decidedBy: "clinician",
          params: { ...base, textUnits: g.textUnits.map((x) => x + "s").join(", ") },
        }),
      );
    } else {
      const dev = ctx.approvedDeviations?.find((d) => d.subject === u.owner && d.number === u.value);
      if (dev !== undefined) {
        out.push(
          makeFinding({
            ...common,
            code: "GUIDELINE_DEVIATION",
            severity: "info",
            audience: CLINICIAN_FIRST,
            decidedBy: "clinician",
            params: { ...base, by: dev.by, note: clip(dev.note, 240) },
          }),
        );
      } else {
        // The page has the number: a missing quote, which the program officer fixes. Otherwise the clinician decides.
        const onPage = pageQuote !== "";
        out.push(
          makeFinding({
            ...common,
            code: "UNGROUNDED_NUMBER",
            severity: "blocking",
            audience: onPage ? ["program_officer", "clinician"] : CLINICIAN_FIRST,
            decidedBy: onPage ? "program_officer" : "clinician",
            params: { ...base, reason: g.status, expectedUnit: (u.unit ?? "").replace(/_/g, " "), pageQuote },
          }),
        );
      }
    }
  }
  if (needsDocument) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "SOURCE_DOCUMENT_MISSING",
        severity: "blocking",
        audience: ["program_officer"],
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: "source" }],
        params: { what: "numbers" },
        source: [],
      }),
    );
  }
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
}
