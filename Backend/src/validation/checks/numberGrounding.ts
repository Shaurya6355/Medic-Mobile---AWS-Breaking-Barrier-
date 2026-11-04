import type { Condition, Model } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import {
  actionSubject,
  describeOutcome,
  describeAction,
  describeDerived,
  describeFollowUp,
  describeQuestion,
  describeRule,
  describeScope,
  derivedSubject,
  followUpSubject,
  outcomeSubject,
  pagesText,
  questionSubject,
  ruleSubject,
  scopeSubject,
} from "../describe.js";
import { TIME_UNITS, canonUnits, groundNumber, tokenize, unitWord } from "../numbers.js";
import type { Grounding } from "../numbers.js";
import { clip, normalizeForQuote, wordTokens } from "../text.js";

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
  /** Numbers of one group (one age band with its cut-off or dose) must all be written in the same passage. */
  group?: string;
  /** Words naming what the number is about; the quote that carries the number must also have one of them. */
  concept?: readonly string[];
  /** Plain words for the concept, for the message. */
  conceptText?: string;
};

export type Cmp = { field: string; op: "at_least" | "less_than"; value: number };

/** The numeric comparison leaves of a condition, as the objects themselves (in order). */
function numericLeaves(root: Condition): { field: string; op: "at_least" | "less_than"; value: number }[] {
  const out: { field: string; op: "at_least" | "less_than"; value: number }[] = [];
  const stack: Condition[] = [root];
  while (stack.length > 0) {
    const c = stack.pop() as Condition;
    if ("field" in c) {
      if (c.op !== "is_yes") out.push(c as { field: string; op: "at_least" | "less_than"; value: number });
    } else {
      const kids = "all" in c ? c.all : c.any;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Condition);
    }
  }
  return out;
}

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

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Numbers written in a short text such as "1 tablet", "10 tablets", "1/2 tablet" or "two tablets", with the word right
 * after each. A number word counts only with a unit right after it; a page number ("page 10") is not a number.
 */
export function numbersInText(text: string): { value: number; unit?: string }[] {
  const out: { value: number; unit?: string }[] = [];
  const toks = [...text.matchAll(/(\d+)\s*\/\s*(\d+)|\d+(?:\.\d+)?|\p{L}+/gu)];
  let pageMode = false;
  toks.forEach((m, i) => {
    const next = toks[i + 1]?.[0];
    const nextWord = next !== undefined && /^\p{L}/u.test(next) ? next : undefined;
    const unit = nextWord !== undefined ? { unit: nextWord } : {};
    if (m[1] !== undefined && m[2] !== undefined) {
      if (Number(m[2]) !== 0 && !pageMode) out.push({ value: Number(m[1]) / Number(m[2]), ...unit });
    } else if (/^\d/.test(m[0])) {
      if (!pageMode) out.push({ value: Number(m[0]), ...unit });
    } else {
      const w = m[0].toLowerCase();
      const n = NUMBER_WORDS[w];
      if (n !== undefined && nextWord !== undefined && unitWord(nextWord) !== undefined) out.push({ value: n, ...unit });
      if (w === "page" || w === "pages" || w === "p" || w === "pg") pageMode = true;
      else if (w !== "and") pageMode = false;
    }
  });
  return out;
}

const STOP = new Set([
  "the", "for", "and", "how", "many", "much", "what", "when", "has", "had", "have", "does", "did", "is", "are", "was", "child", "child's",
  "look", "ask", "any", "with", "from", "this", "that", "per", "in", "of", "to", "or", "a", "an", "there", "his", "her", "their", "enter", "number",
  "yes", "not", "been", "since", "long",
]);

/** Words naming what a question is about (its id and label), without filler words and units of time. */
function conceptOf(q: { id: string; label: string } | undefined): string[] {
  if (q === undefined) return [];
  const words = [...q.id.split(/[^a-z]+/i), ...wordTokens(q.label)].map((w) => w.toLowerCase().replace(/'s$/, ""));
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d/.test(w)) continue;
    const u = unitWord(w);
    if (u !== undefined && TIME_UNITS.has(u)) continue;
    out.add(w);
  }
  return [...out];
}

const FOLLOW_UP_CONCEPT = ["follow", "return", "visit", "review", "back", "again", "reassess"];
const AGE_CONCEPT = ["age", "aged", "old"];

/** Does the quote mention one of the concept words (a word starting with it, or it starting with the word, 4 letters or more)? */
function mentions(quote: string, concept: readonly string[] | undefined): boolean {
  if (concept === undefined || concept.length === 0) return true;
  const words = wordTokens(quote);
  return concept.some((c) => words.some((w) => w === c || (c.length >= 4 && w.length >= 4 && (w.startsWith(c) || c.startsWith(w)))));
}

/** One age band per piece: a quote is cut before each "age" so that each band and the numbers after it stay together. */
function pieces(quote: string): string[] {
  return quote.split(/(?=\bage[ds]?\b)/i).filter((x) => x.trim() !== "");
}

const passes = (g: Grounding): boolean => g.status === "grounded" || g.status === "converted";

export const phrase = (op: Cmp["op"], v: string): string => (op === "at_least" ? `${v} or more` : `less than ${v}`);

function collectUses(model: Model): { uses: Use[]; limits: string[]; limitSubjects: Subject[] } {
  const uses: Use[] = [];
  const questions = new Map(model.questions.map((q) => [q.id, q]));
  const isTeam = (origin: "guideline" | "team", sources: readonly Source[] | undefined): boolean =>
    origin === "team" && (sources === undefined || sources.length === 0);

  const ageField = model.questions.find((q) => /month/.test(q.unit ?? "") && /\bage|^age|age_/i.test(`${q.id} ${q.label}`))?.id;
  let groupNo = 0;
  const addCondition = (
    owner: string,
    subject: Subject,
    item: string,
    when: Condition,
    origin: "guideline" | "team",
    sources: readonly Source[] | undefined,
  ): void => {
    // An "all" group that compares the age with numbers and also another number is one age band: its numbers go together.
    const groupOf = new Map<Cmp, string>();
    const stack: Condition[] = [when];
    while (stack.length > 0) {
      const c = stack.pop() as Condition;
      if ("field" in c) continue;
      const kids = "all" in c ? c.all : c.any;
      for (const k of kids) stack.push(k);
      if (!("all" in c)) continue;
      const leaves = kids.filter((k): k is Extract<Condition, { field: string }> => "field" in k && k.op !== "is_yes");
      if (leaves.length >= 2 && ageField !== undefined && leaves.some((l) => l.field === ageField)) {
        const key = `${owner}#${++groupNo}`;
        for (const l of leaves) groupOf.set(l as unknown as Cmp, key);
      }
    }
    for (const c of numericLeaves(when)) {
      const q = questions.get(c.field);
      const unit = q?.unit;
      const subjects: Subject[] = [subject];
      if (q !== undefined) subjects.push(questionSubject(q));
      const concept = c.field === ageField ? AGE_CONCEPT : conceptOf(q);
      const group = groupOf.get(c as unknown as Cmp);
      uses.push({
        owner,
        subjects,
        item,
        value: c.value,
        ...(unit !== undefined ? { unit } : {}),
        usage: `${phrase(c.op, `${c.value}${unit !== undefined ? " " + unit.replace(/_/g, " ") : ""}`)} for "${clip(q?.label ?? c.field, 60)}"`,
        team: isTeam(origin, sources),
        sources: sources ?? [],
        concept,
        conceptText: `"${clip(q?.label ?? c.field, 60)}"`,
        ...(group !== undefined ? { group } : {}),
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
      group: "scope",
      concept: AGE_CONCEPT,
      conceptText: "the child's age",
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
          concept: conceptOf(q),
          conceptText: `"${clip(q.label, 60)}"`,
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
      (a.dose_by_age ?? []).forEach((d, di) => {
        const range = `${d.age_months_min} up to ${d.age_months_below} months`;
        const group = `${subject.id}#dose${di}`;
        for (const v of [d.age_months_min, d.age_months_below]) {
          uses.push({ owner: subject.id, subjects: [subject], item, value: v, unit: "months", usage: `an age limit of ${v} months in the dose table (${range})`, team, sources, group });
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
              group,
            });
          }
        }
      });
    });
    const f = o.follow_up;
    if (f !== null) {
      const subject = followUpSubject(o);
      const item = describeFollowUp(o);
      const team = isTeam(f.origin, f.source);
      const sources = f.source ?? [];
      const fc = { concept: FOLLOW_UP_CONCEPT, conceptText: "a follow-up or return visit" };
      if (f.due_in_days !== null) {
        uses.push({ owner: o.id, subjects: [subject], item, value: f.due_in_days, unit: "days", usage: `a follow-up due after ${f.due_in_days} days`, team, sources, ...fc });
      }
      if (f.task_window_days_after_due !== null) {
        uses.push({
          owner: o.id,
          subjects: [subject],
          item,
          value: f.task_window_days_after_due,
          unit: "days",
          usage: `a follow-up task that stays open for ${f.task_window_days_after_due} days after it is due`,
          team,
          sources,
          ...fc,
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
  const unconfirmed = new Set(unconfirmedTeamDrivers(model));
  for (const [owner, list] of teamByOwner) {
    if (unconfirmed.has(owner)) continue;
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
  const grounded = new Set<Use>();
  for (const u of uses) {
    if (u.team) continue;
    if (doc === undefined) {
      needsDocument = true;
      continue;
    }
    const pages = [...new Set(u.sources.map((s) => s.page))];
    // Quote-only: the number must be written in a quote the item itself cites, not elsewhere on the page,
    // and that quote must be about the same thing (no borrowing "7 days" from a passage about fever).
    const perQuote = u.sources.map((s) => groundNumber(tokenize([s.quote], u.freq === true), u.value, u.unit));
    const okIdx = perQuote.flatMap((g, i) => (passes(g) && mentions((u.sources[i] as Source).quote, u.concept) ? [i] : []));
    let g: Grounding;
    if (okIdx.length > 0) {
      const direct = okIdx.find((i) => perQuote[i]?.status === "grounded");
      g = direct !== undefined ? { status: "grounded" } : (perQuote[okIdx[0] as number] as Grounding);
      grounded.add(u);
    } else if (perQuote.some(passes)) {
      const i = perQuote.findIndex(passes);
      const s = u.sources[i] as Source;
      out.push(
        makeFinding({
          check: CHECK,
          code: "NUMBER_CONTEXT_MISMATCH",
          severity: "blocking",
          audience: CLINICIAN_FIRST,
          decidedBy: "clinician",
          subjects: u.subjects,
          params: { item: u.item, number: u.value, usage: u.usage, concept: u.conceptText ?? "", page: String(s.page), quote: clip(s.quote, 200) },
          source: u.sources.map((x) => ({ page: x.page, quote: x.quote })),
        }),
      );
      continue;
    } else {
      g = groundNumber(tokenize(u.sources.map((s) => s.quote), u.freq === true), u.value, u.unit);
    }
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
  if (doc !== undefined) out.push(...pairing(uses, grounded));
  out.push(...teamThresholds(model, teamByOwner));
  out.push(...textNumbers(model));
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

/**
 * Numbers that belong together (an age band and its cut-off, an age band and its dose and total) must be written
 * in the same passage, cut at each "age": both 50 and 40 being in the quote does not say which band each goes with.
 */
function pairing(uses: readonly Use[], grounded: ReadonlySet<Use>): Finding[] {
  const groups = new Map<string, Use[]>();
  for (const u of uses) if (u.group !== undefined && !u.team) groups.set(u.group, [...(groups.get(u.group) ?? []), u]);
  const out: Finding[] = [];
  for (const list of groups.values()) {
    if (list.length < 2 || !list.every((u) => grounded.has(u))) continue;
    const first = list[0] as Use;
    let common: Set<string> | undefined;
    for (const u of list) {
      const keys = new Set<string>();
      u.sources.forEach((s, qi) => pieces(s.quote).forEach((piece, pi) => {
        if (passes(groundNumber(tokenize([piece], u.freq === true), u.value, u.unit))) keys.add(`${qi}:${pi}`);
      }));
      common = common === undefined ? keys : new Set([...common].filter((k) => keys.has(k)));
    }
    if (common !== undefined && common.size > 0) continue;
    const subjects = [...new Map(list.flatMap((u) => u.subjects).map((x) => [x.kind + x.id, x])).values()];
    const src = first.sources[0];
    out.push(
      makeFinding({
        check: CHECK,
        code: "NUMBER_PAIRING_MISMATCH",
        severity: "blocking",
        audience: CLINICIAN_FIRST,
        decidedBy: "clinician",
        subjects,
        params: {
          item: first.item,
          usage: [...new Set(list.map((u) => u.usage))].join("; "),
          numbers: [...new Set(list.map((u) => String(u.value)))].join(", "),
          page: pagesText(first.sources.map((x) => x.page)),
          quote: clip(src?.quote ?? "", 200),
        },
        source: first.sources.map((x) => ({ page: x.page, quote: x.quote })),
      }),
    );
  }
  return out;
}

/** Ids of calculated values (directly or through other calculated values) that rules read. */
function drivingDerived(model: Model): Set<string> {
  const derived = new Map(model.derived.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const stack: Condition[] = model.rules.flatMap((r) => (r.when === "otherwise" ? [] : [r.when]));
  while (stack.length > 0) {
    const c = stack.pop() as Condition;
    if ("field" in c) {
      const d = derived.get(c.field);
      if (d !== undefined && !seen.has(d.id)) {
        seen.add(d.id);
        stack.push(d.definition);
      }
    } else stack.push(...("all" in c ? c.all : c.any));
  }
  return seen;
}

/**
 * A clinician has answered an open question that names the item AND writes each of the team's numbers in its question
 * or answer, so an answer to some other question about the item (an age band, say) cannot confirm them by accident.
 */
function clinicianConfirmed(model: Model, id: string, numbers: readonly number[]): boolean {
  return model.open_questions.some((q) => {
    if (q.route_to !== "clinician" || q.status !== "resolved" || (q.resolution ?? "").trim() === "" || !q.affects.includes(id)) return false;
    const said = new Set(numbersInText(`${q.question} ${q.resolution ?? ""}`).map((n) => n.value));
    return numbers.every((n) => said.has(n));
  });
}

/**
 * Team-origin rules and calculated values that decide a result, compare numbers, cite nothing and are not confirmed by a
 * clinician. A comparison of the age with the covered age range itself (whose numbers are checked on the scope) does not count.
 */
function unconfirmedTeamDrivers(model: Model): string[] {
  const driving = drivingDerived(model);
  const ageField = model.questions.find((q) => /month/.test(q.unit ?? "") && /\bage|^age|age_/i.test(`${q.id} ${q.label}`))?.id;
  const scopeAges = new Set([model.scope.age_months_min, model.scope.age_months_below]);
  const ownNumbers = (when: Condition): number[] => [...new Set(numericComparisons(when).filter((c) => !(c.field === ageField && scopeAges.has(c.value))).map((c) => c.value))];
  const items: { id: string; origin: string; source?: readonly Source[] | undefined; when: Condition }[] = [
    ...model.derived.filter((d) => driving.has(d.id)).map((d) => ({ id: d.id, origin: d.origin, source: d.source, when: d.definition })),
    ...model.rules.flatMap((r) => (r.when === "otherwise" ? [] : [{ id: r.id, origin: r.origin, source: r.source, when: r.when }])),
  ];
  return items
    .filter((it) => {
      if (it.origin !== "team" || (it.source ?? []).length > 0) return false;
      const own = ownNumbers(it.when);
      return own.length > 0 && !clinicianConfirmed(model, it.id, own);
    })
    .map((it) => it.id);
}

/** M10: cut-offs the team set itself on an item that decides the result block until a clinician confirms them in an open question. */
function teamThresholds(model: Model, teamByOwner: ReadonlyMap<string, Use[]>): Finding[] {
  const out: Finding[] = [];
  for (const id of unconfirmedTeamDrivers(model)) {
    const list = teamByOwner.get(id) ?? [];
    const d = model.derived.find((x) => x.id === id);
    const r = model.rules.find((x) => x.id === id);
    const subject: Subject = d !== undefined ? derivedSubject(d) : ruleSubject(r as Model["rules"][number]);
    const item = d !== undefined ? describeDerived(d) : describeRule(model, r as Model["rules"][number]);
    const subjects = [...new Map([subject, ...list.flatMap((u) => u.subjects)].map((x) => [x.kind + x.id, x])).values()];
    out.push(
      makeFinding({
        check: CHECK,
        code: "TEAM_THRESHOLD_UNCONFIRMED",
        severity: "blocking",
        audience: CLINICIAN_FIRST,
        decidedBy: "clinician",
        subjects,
        params: { item, id, usage: [...new Set(list.map((u) => u.usage))].join("; ") },
        source: [],
      }),
    );
  }
  return out;
}

/**
 * Numbers in words the health worker reads (question labels, labels of calculated values, result titles, action texts)
 * must be in a quote of that item; for a result, its own quotes and those of its actions and follow-up count.
 */
function textNumbers(model: Model): Finding[] {
  type T = { subject: Subject; item: string; text: string; sources: readonly Source[] };
  const texts: T[] = [];
  for (const q of model.questions) texts.push({ subject: questionSubject(q), item: describeQuestion(q), text: q.label, sources: q.source ?? [] });
  for (const d of model.derived) texts.push({ subject: derivedSubject(d), item: describeDerived(d), text: d.label, sources: d.source ?? [] });
  for (const o of model.outcomes) {
    const all = [...(o.source ?? []), ...o.actions.flatMap((a) => a.source ?? []), ...(o.follow_up?.source ?? [])];
    texts.push({ subject: outcomeSubject(o), item: describeOutcome(o), text: o.title, sources: all });
    o.actions.forEach((a, i) => texts.push({ subject: actionSubject(o, i), item: describeAction(o, i), text: a.text, sources: a.source ?? [] }));
  }
  const out: Finding[] = [];
  for (const t of texts) {
    const toks = tokenize(t.sources.map((s) => s.quote), true);
    const bad: string[] = [];
    for (const n of numbersInText(t.text)) {
      const unit = n.unit !== undefined && canonUnits(n.unit).size > 0 ? n.unit : undefined;
      if (!passes(groundNumber(toks, n.value, unit))) bad.push(unit !== undefined ? `${n.value} ${n.unit}` : String(n.value));
    }
    if (bad.length === 0) continue;
    const first = t.sources[0];
    out.push(
      makeFinding({
        check: CHECK,
        code: "NUMBER_IN_TEXT_UNSUPPORTED",
        severity: "blocking",
        audience: CLINICIAN_FIRST,
        decidedBy: "clinician",
        subjects: [t.subject],
        params: {
          item: t.item,
          text: clip(t.text, 200),
          numbers: [...new Set(bad)].join(", "),
          page: pagesText(t.sources.map((s) => s.page)),
          quote: clip(first?.quote ?? "", 200),
        },
        source: t.sources.map((s) => ({ page: s.page, quote: s.quote })),
      }),
    );
  }
  return out;
}
