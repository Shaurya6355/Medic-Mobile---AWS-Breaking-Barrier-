import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseModel } from "../../src/logic/schema.js";
import { runChecks } from "../../src/validation/runChecks.js";
import { demoSettings, goldenCases, realDocument, realExtraction } from "./helpers.js";
import { MUTS } from "./redteam1.mutations.js";

/**
 * Regression tests from red team 1: clinically wrong logic models that used to reach signature with no
 * blocking finding. The baseline is the real draft (tests/fixtures/fill/draft-cough.json) resolved against
 * the real extraction, with every open question marked resolved, so it has no blocking finding of its own.
 */
const baseline = (): any => {
  const m = JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/validation/redteam1-baseline.json"), "utf8"));
  for (const q of m.open_questions) {
    q.status = "resolved";
    q.resolution = "Resolved by clinician (red-team baseline).";
  }
  return m;
};

const doc = realDocument();
const extraction = realExtraction();
// golden-proposed.json uses the outcome id of v1.json for the outside-age result
const golden = goldenCases((g) => {
  for (const c of g) if (c.expected_outcome === "refer_outside_age_range") c.expected_outcome = "outside_age_range";
});
const settings = demoSettings();

/** The checks this work changed; the baseline must have no blocking finding from them. */
const LOGIC_CHECKS = new Set(["dangerSignCoverage", "severityOrder", "followUpConsistency", "ageGroups", "schemaReferences", "fieldNames", "reachability", "deadInputs", "useBeforeAsk", "closedTable", "goldenCases"]);

function blockingOf(name: string, full: boolean): string[] {
  const m = baseline();
  const raw = MUTS[name]!.fn(m) ?? m;
  const p = parseModel(raw);
  const ctx: any = { model: p.ok ? p.value : raw, document: doc, extraction };
  if (full) {
    ctx.goldenCases = golden;
    ctx.compileSettings = settings;
  }
  const r = runChecks(ctx);
  return [...new Set(r.findings.filter((f) => f.severity === "blocking").map((f) => `${f.check}:${f.code}`))];
}

// Blocking findings of the baseline from checks other teams are changing (number and quote grounding, open questions):
// a mutation counts as caught only by a blocking finding the baseline does not already have.
const BASE_OTHER = { prod: new Set(blockingOf("M00_baseline", false)), full: new Set(blockingOf("M00_baseline", true)) };
const caughtBy = (name: string, full: boolean): string[] => {
  const base = full ? BASE_OTHER.full : BASE_OTHER.prod;
  return blockingOf(name, full).filter((x) => !base.has(x));
};
const mine = (xs: Iterable<string>): string[] => [...xs].filter((x) => LOGIC_CHECKS.has(x.split(":")[0]!));

/** Gaps fixed by the logic checks (this work). Caught with the production context: booklet and extraction only. */
const FIXED_PROD = [
  "M08_cough_days_op_flip", "M11_drop_convulsions_from_ds", "M12_drop_convulsions_from_ds_reuse_in_R5", "M13_drop_chest_indrawing_from_ds_keep_in_R2",
  "M80_ds_wrapped_in_cough_guard", "M89_convulsions_hidden_behind_cough_guarded", "M91_scope_excluded_list_used_to_hide_sign",
  "M27b_remove_R1_scrub_affects", "M28_R1_less_than_2_to_1", "M66_neg_zero_age",
  "M19_refer_urgent_sev_1_to_4", "M22_all_severities_flattened_to_5", "M33_refer_urgent_title_and_actions_neutered",
  "M41_dose_by_age_removed", "M86_age_unit_renamed_then_dose_overlap", "M87_age_unit_renamed_only",
  "M50_breaths_constraint_max_45", "M51_age_constraint_max_11", "M53_cough_days_constraint_max_13",
  "M43_remove_followup_home_treatment", "M45_followup_scheduled_to_on_return", "M47_followup_due_0",
  "M72_whitespace_title", "M73_id_constructor", "M92_id_constructor_conditional",
];

/** Caught before this work and still caught (production context). */
const ALREADY_PROD = [
  "M01_fb_infant_50_to_51", "M03_fb_ageband_12_to_13", "M05_fb_any_to_all", "M06_ds_any_to_all", "M07_cough_days_14_to_15",
  "M09_cough_days_14_to_7_with_real_quote_of_7", "M14_remove_convulsions_question_entirely", "M15_remove_sleepy_question_entirely",
  "M16_ds_convulsions_not_negated_trick_any_with_impossible", "M17_R2_all_to_any", "M18_swap_R5_R6_outcomes", "M20_refer_urgent_sev_1_to_9",
  "M21_refer_with_ab_sev_1_to_3", "M23_outside_age_sev_1_to_5", "M24_swap_sev_home_and_mild", "M25_swap_R4_R5_outcomes", "M26_R3_before_R2",
  "M27_remove_R1_and_outside_outcome", "M29_R1_less_than_2_to_1_and_scope_min_1", "M30_rule_undefined_outcome",
  "M31_catchall_to_urgent_then_R5_to_no_cough", "M32_outcome_actions_swapped_between_refer_and_home", "M34_dose_overlap", "M35_dose_gap",
  "M38_dose_1_to_3_tablets", "M40_dose_drop_band_entirely", "M42_dose_band_reversed_lo_gt_hi", "M44_followup_3_to_30_days",
  "M46_remove_followup_refer_urgent", "M48_breaths_shown_never", "M49_breaths_shown_only_age_ge_12", "M52_age_constraint_min2_max59",
  "M54_convulsions_optional", "M55_convulsions_shown_only_if_cough", "M56_scope_below_60_to_61", "M58_cyclic_derived", "M59_nesting_33",
  "M62_wide_any_501", "M63_unicode_lookalike_id", "M64_NaN_value", "M65_Infinity_value", "M67_huge_threshold_1e308",
  "M69_dup_id_derived_eq_question", "M70_dup_id_outcome_eq_question", "M71_whitespace_action_text", "M74_id_proto", "M75_extra_key",
  "M76_reserved_field_name", "M77_grid_explosion_20_unused_yes_no", "M78_bool_compared_numerically", "M79_fb_infant_band_lower_drop",
  "M82_dose_band_for_ref_shifted_to_match_tamper", "M83_dose_1_to_half_tablet", "M90_catchall_to_urgent",
];

describe("red team 1 regressions", () => {
  it("the resolved baseline has no blocking finding when test cases and form settings are supplied", () => {
    expect(mine(BASE_OTHER.full)).toEqual([]);
  });

  it("without test cases the baseline is held only because two equally urgent results overlap and no test case pins which one wins", () => {
    expect(mine(BASE_OTHER.prod)).toEqual(["severityOrder:URGENT_OVERLAP_UNTESTED"]);
  });

  it("valid but unusual drafts stay unblocked", () => {
    for (const n of ["M60_nesting_31_valid", "M61_wide_any_500_dupes", "M68_huge_constraint_max"]) expect(caughtBy(n, true), n).toEqual([]);
  });

  for (const n of FIXED_PROD) {
    it(`${n} is now blocked with the production context`, () => {
      expect(mine(caughtBy(n, true)), n).not.toEqual([]);
      expect(mine(caughtBy(n, false)), n).not.toEqual([]);
    });
  }

  it("M81 (pre-referral antibiotic withheld from infants) is blocked by the infant test case", () => {
    expect(caughtBy("M81_R2_with_ab_only_for_age_ge_12", true)).toContain("goldenCases:GOLDEN_MISMATCH");
    expect(blockingOf("M81_R2_with_ab_only_for_age_ge_12", false)).toContain("severityOrder:URGENT_OVERLAP_UNTESTED");
  });

  for (const n of ALREADY_PROD) {
    it(`${n} stays blocked`, { timeout: 60000 }, () => {
      expect(caughtBy(n, false), n).not.toEqual([]);
    });
  }
});
