import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { derivedSubject, outcomeSubject, scopeSubject } from "../describe.js";
import { citation } from "./common.js";
import { bandText, bandsOf, monthsQuestionId, partitionProblems, sameBands } from "./ageBands.js";
import type { Band } from "./ageBands.js";

export const CHECK = "ageGroups";

/**
 * Age groups. The covered ages [age_months_min, age_months_below) must be split exactly (no gap, no overlap)
 * by the age bands of every calculated value that tests the age question, and by every dose-by-age list.
 * The dose bands must also be the same as the bands used for fast breathing (the calculated values' bands),
 * or a child could be given a dose for the wrong age.
 */
export function ageGroups(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const months = monthsQuestionId(model);
  if (months === undefined) return [];
  const { age_months_min: min, age_months_below: below } = model.scope;
  const out: Finding[] = [];
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
  for (const d of model.derived) {
    const bands = bandsOf(d.definition, months);
    if (bands.length === 0) continue;
    derivedBands.push({ id: d.id, bands });
    report(partitionProblems(bands, min, below), `the age bands of "${d.label}"`, derivedSubject(d), d);
  }

  for (const o of model.outcomes) {
    for (const act of o.actions) {
      if (act.dose_by_age === undefined) continue;
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
