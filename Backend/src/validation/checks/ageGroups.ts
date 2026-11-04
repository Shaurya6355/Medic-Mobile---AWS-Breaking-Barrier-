import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { derivedSubject, outcomeSubject, questionSubject, scopeSubject } from "../describe.js";
import { citation } from "./common.js";
import { bandText, bandsOf, monthsQuestionId, partitionProblems, sameBands } from "./ageBands.js";
import type { Band } from "./ageBands.js";

export const CHECK = "ageGroups";

/**
 * Age groups. The covered ages [age_months_min, age_months_below) must be split exactly (no gap, no overlap)
 * by the age bands of every calculated value that tests the age question, and by every dose-by-age list.
 * The dose bands must also be the same as the bands used for fast breathing (the calculated values' bands),
 * or a child could be given a dose for the wrong age.
 * Also (red team 1): without an age question in months the check blocks (AGE_QUESTION_MISSING) instead of
 * switching off, and the dose lists are still checked against the covered ages; the entry limits of the age
 * question must allow every covered age (AGE_LIMITS_EXCLUDE_SCOPE); and an action whose own text or quotes give
 * dose rows by age ("Age 2 months up to 12 months—1 tablet") must have a dose list (DOSE_TABLE_MISSING).
 */
export function ageGroups(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const months = monthsQuestionId(model);
  const { age_months_min: min, age_months_below: below } = model.scope;
  const out: Finding[] = [];
  const both = ["clinician", "program_officer"] as ("clinician" | "program_officer")[];
  if (months === undefined) {
    // Never switch the age checks off silently: the draft always has covered ages.
    const near = model.questions.find((q) => q.answer_type === "integer" && /age/.test(q.id));
    out.push(
      makeFinding({
        check: CHECK,
        code: "AGE_QUESTION_MISSING",
        severity: "blocking",
        audience: ["program_officer", "clinician"],
        decidedBy: "program_officer",
        subjects: [near === undefined ? scopeSubject : questionSubject(near), ...(near === undefined ? [] : [scopeSubject])],
        params: {
          problem:
            near === undefined
              ? 'no whole-number question measured in "months" asks for the child\'s age'
              : `the question "${near.label}" is measured in "${near.unit ?? "no unit"}" instead of "months"`,
        },
        source: [],
      }),
    );
  } else {
    const age = model.questions.find((q) => q.id === months);
    const lim = age?.constraint;
    if (age !== undefined && lim !== undefined && (lim.min > min || lim.max < below - 1)) {
      out.push(
        makeFinding({
          check: CHECK,
          code: "AGE_LIMITS_EXCLUDE_SCOPE",
          severity: "blocking",
          audience: ["program_officer", "clinician"],
          decidedBy: "program_officer",
          subjects: [questionSubject(age), scopeSubject],
          params: { question: age.label, min: lim.min, max: lim.max, lo: min, hi: below },
          source: [],
        }),
      );
    }
  }
  const report = (problems: ReturnType<typeof partitionProblems>, where: string, subject: Finding["subjects"][number], src: Parameters<typeof citation>[0]): void => {
    for (const p of problems) {
      const c = citation(src);
      out.push(
        makeFinding({
          check: CHECK,
          code: p.kind === "gap" ? "AGE_GAP" : "AGE_OVERLAP",
          severity: "blocking",
          audience: ["clinician", "program_officer"],
          decidedBy: "clinician",
          subjects: [subject, scopeSubject],
          params: { where, from: p.from, to: p.to, ...c.params },
          source: c.source,
        }),
      );
    }
  };

  const derivedBands: Array<{ id: string; bands: Band[] }> = [];
  for (const d of months === undefined ? [] : model.derived) {
    const bands = bandsOf(d.definition, months as string);
    if (bands.length === 0) continue;
    derivedBands.push({ id: d.id, bands });
    report(partitionProblems(bands, min, below), `the age bands of "${d.label}"`, derivedSubject(d), d);
  }

  for (const o of model.outcomes) {
    for (const act of o.actions) {
      if (act.dose_by_age === undefined) {
        if (hasDoseRows(act)) {
          const src = act.source !== undefined && act.source.length > 0 ? act : o;
          const c = citation(src);
          out.push(
            makeFinding({
              check: CHECK,
              code: "DOSE_TABLE_MISSING",
              severity: "blocking",
              audience: both,
              decidedBy: "clinician",
              subjects: [outcomeSubject(o)],
              params: { item: `the action "${act.text.length > 60 ? act.text.slice(0, 57) + "..." : act.text}" of the result "${o.title}"`, ...c.params },
              source: c.source,
            }),
          );
        }
        continue;
      }
      const bands = act.dose_by_age.map((x) => ({ lo: x.age_months_min, hi: x.age_months_below }));
      const where = `the doses by age of the action "${act.text.length > 60 ? act.text.slice(0, 57) + "..." : act.text}"`;
      const src = act.source !== undefined && act.source.length > 0 ? act : o;
      report(partitionProblems(bands, min, below), where, outcomeSubject(o), src);
      if (derivedBands.length > 0 && !derivedBands.some((d) => sameBands(bands, d.bands))) {
        const ref = derivedBands[0] as { id: string; bands: Band[] };
        const c = citation(src);
        out.push(
          makeFinding({
            check: CHECK,
            code: "DOSE_BANDS_MISMATCH",
            severity: "blocking",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects: [outcomeSubject(o), derivedSubject(model.derived.find((d) => d.id === ref.id) as Parameters<typeof derivedSubject>[0])],
            params: { item: where, doseBands: bandText(bands), ruleBands: bandText(ref.bands), ...c.params },
            source: c.source,
          }),
        );
      }
    }
  }
  return out;
}

/** A dose row by age: "2 months up to 12 months—1 tablet", "12 months up to 5 years - 2 tablets". */
const DOSE_ROW = /\d+\s*(?:months?|years?)\s+up\s+to\s+\d+\s*(?:months?|years?)\s*[\u2010-\u2015\-:]+\s*\S/i;

function hasDoseRows(act: { text: string; source?: readonly { quote: string }[] | undefined }): boolean {
  const texts = [act.text, ...(act.source ?? []).map((x) => x.quote)];
  return texts.some((t) => DOSE_ROW.test(t.replace(/\s+/g, " ")));
}
