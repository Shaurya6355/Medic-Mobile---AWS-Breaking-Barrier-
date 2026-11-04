import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import {
  actionSubject,
  describeAction,
  describeDerived,
  describeOutcome,
  describeQuestion,
  derivedSubject,
  outcomeSubject,
  questionSubject,
} from "../describe.js";
import type { Subject } from "../finding.js";
import { isReferral } from "./followUpConsistency.js";
import { citation } from "./common.js";
import { clip, hasNegation, isVerbatim, wordTokens } from "../text.js";

export const CHECK = "clinicalText";

const STOP = new Set([
  "child", "childs", "does", "have", "look", "with", "this", "that", "from", "there", "what", "when", "many", "much", "been", "they", "your", "will",
  "should", "number", "the", "has", "had", "are", "for", "and", "not", "any", "how", "you", "can", "his", "her", "was", "did", "yes", "all", "out",
]);

/** Telling words of a text, cut to 5 letters (3 letters or more, no filler). */
function topicWords(t: string): Set<string> {
  return new Set(wordTokens(t).map((w) => w.replace(/'s$/, "")).filter((w) => w.length >= 3 && /^\p{L}+$/u.test(w) && !STOP.has(w)).map((w) => w.slice(0, 5)));
}

type Shown = { subject: Subject; item: string; text: string; sources: readonly { page: number; quote: string }[]; topic: boolean };

/** Text shown to the health worker that the booklet should back: question labels, labels of calculated values, result titles, actions. */
function shownTexts(model: CheckContext["model"]): { labels: Shown[]; actions: Shown[] } {
  const labels: Shown[] = [];
  for (const q of model.questions) labels.push({ subject: questionSubject(q), item: describeQuestion(q), text: q.label, sources: q.source ?? [], topic: true });
  // A calculated value cites the criteria it is made of, which need not repeat its name: no topic check for it.
  for (const d of model.derived) labels.push({ subject: derivedSubject(d), item: describeDerived(d), text: d.label, sources: d.source ?? [], topic: false });
  for (const o of model.outcomes) labels.push({ subject: outcomeSubject(o), item: describeOutcome(o), text: o.title, sources: o.source ?? [], topic: true });
  const actions: Shown[] = [];
  for (const o of model.outcomes) {
    o.actions.forEach((a, i) => {
      if (a.origin === "team" || a.text.trim() === "") return;
      actions.push({ subject: actionSubject(o, i), item: describeAction(o, i), text: a.text, sources: a.source ?? [], topic: false });
    });
  }
  return { labels, actions };
}

/**
 * Wording checks (red team 2). Labels and titles are written by the AI, so for each one that has booklet quotes:
 *  - a "not" ("no", "without", ...) must not be added or dropped: TEXT_NEGATION_MISMATCH (blocking);
 *  - a question label or result title must share a telling word with its quotes: TEXT_OFF_TOPIC (blocking);
 * and every label, title or action text that is not the booklet's own words is listed once for the clinician: AI_WORDED_TEXT (warning).
 */
function wording(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { labels, actions } = shownTexts(ctx.model);
  const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const };
  for (const t of labels) {
    if (t.sources.length === 0) continue;
    const quotes = t.sources.map((x) => x.quote);
    const first = t.sources[0] as { page: number; quote: string };
    const cite = { page: [...new Set(t.sources.map((x) => x.page))].sort((a, b) => a - b).join(" and "), quote: clip(first.quote, 200) };
    const source = t.sources.map((x) => ({ page: x.page, quote: x.quote }));
    const neg = hasNegation(t.text);
    const quoteNeg = quotes.map(hasNegation);
    if ((neg && !quoteNeg.some(Boolean)) || (!neg && quoteNeg.every(Boolean))) {
      out.push(makeFinding({ ...common, code: "TEXT_NEGATION_MISMATCH", severity: "blocking", subjects: [t.subject], source, params: { item: t.item, text: clip(t.text, 200), says: neg ? "says no or not" : "has no no or not", booklet: neg ? "has none" : "does", ...cite } }));
    }
    const qw = new Set(quotes.flatMap((q) => [...topicWords(q)]));
    const tw = [...topicWords(t.text)];
    if (t.topic && tw.length > 0 && !tw.some((w) => qw.has(w))) {
      out.push(makeFinding({ ...common, code: "TEXT_OFF_TOPIC", severity: "blocking", subjects: [t.subject], source, params: { item: t.item, text: clip(t.text, 200), ...cite } }));
    }
  }
  // An action built from several quotes of one passage is still the booklet's words: the quotes joined count too.
  const worded = [...labels, ...actions].filter((t) => !isVerbatim(t.text, [...t.sources.map((x) => x.quote), t.sources.map((x) => x.quote).join(" ")]));
  if (worded.length > 0) {
    const MAX = 700;
    let texts = "";
    let shown = 0;
    for (const t of worded) {
      const piece = `"${clip(t.text, 120)}"`;
      if (texts.length + piece.length > MAX) break;
      texts += (shown > 0 ? "; " : "") + piece;
      shown++;
    }
    out.push(
      makeFinding({
        check: CHECK,
        code: "AI_WORDED_TEXT",
        severity: "warning",
        audience: ["clinician"],
        decidedBy: "clinician",
        subjects: [...new Map(worded.map((t) => [t.subject.kind + t.subject.id, t.subject])).values()],
        params: { count: worded.length, texts, more: worded.length - shown },
        source: [],
      }),
    );
  }
  return out;
}

/**
 * Every result tells the health worker what to do (at least one action with words). A referral needs at least
 * one action taken from the booklet with a quote. Wording the team wrote itself is listed for the clinician to confirm.
 */
export function clinicalText(ctx: CheckContext): Finding[] {
  const out: Finding[] = wording(ctx);
  for (const o of ctx.model.outcomes) {
    const item = describeOutcome(o);
    const cite = citation(o);
    const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const, subjects: [outcomeSubject(o)], source: cite.source };
    if (!o.actions.some((a) => a.text.trim() !== "")) {
      out.push(makeFinding({ ...common, code: "CLINICAL_TEXT_MISSING", severity: "blocking", params: { item, ...cite.params } }));
    }
    if (isReferral(o) && !o.actions.some((a) => a.origin === "guideline" && a.source !== undefined && a.source.length > 0 && a.text.trim() !== "")) {
      out.push(makeFinding({ ...common, code: "CLINICAL_TEXT_UNSOURCED", severity: "blocking", params: { item, ...cite.params } }));
    }
    const team = o.actions.filter((a) => a.origin === "team" && a.text.trim() !== "");
    if (team.length > 0) {
      out.push(
        makeFinding({
          ...common,
          audience: ["clinician"],
          source: [],
          code: "TEAM_TEXT_TO_CONFIRM",
          severity: "info",
          params: { item, texts: team.map((a) => `"${clip(a.text, 160)}"`).join("; ") },
        }),
      );
    }
  }
  return out;
}
