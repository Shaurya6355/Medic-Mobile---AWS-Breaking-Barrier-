import type { Audience } from "./finding.js";

type Params = Record<string, string | number | boolean>;
type Template = (p: Params, audience: Audience) => string;

/**
 * Deterministic plain-language messages, one per finding code. Messages never come from a model.
 * Each is one short paragraph: what is wrong, what the booklet says (page and quote),
 * what the model has, and who decides. Written for a clinician or a program officer.
 */

const s = (p: Params, k: string): string => {
  const v = p[k];
  return v === undefined ? "" : String(v);
};

/** "page 8" or "pages 7 and 8"; empty when no page is known. */
function pageText(p: Params): string {
  const page = s(p, "page");
  if (page === "") return "no booklet page is cited";
  return /[ ,]/.test(page) ? `pages ${page}` : `page ${page}`;
}

function booklet(p: Params): string {
  const q = s(p, "quote");
  return q === "" ? `The booklet (${pageText(p)}) gives nothing to check this against.` : `The booklet (${pageText(p)}) says: "${q}".`;
}

/** The booklet passage when one is known; nothing at all otherwise (for findings about the model's structure). */
function bookletOpt(p: Params): string {
  return s(p, "quote") === "" ? "" : booklet(p);
}

const ASK_CLINICIAN = "The clinician decides whether this is a mistake to correct or a deliberate change from the booklet.";

const TEMPLATES: Record<string, Template> = {
  SCHEMA_INVALID: (p) =>
    `The draft is not in the expected form, so it cannot be checked further: ${s(p, "issue")} (at ${s(p, "path")}). The booklet is not involved. The program officer asks for the draft to be produced again.`,

  CHECK_CRASHED: (p) =>
    `One of the safety checks (${s(p, "check")}) stopped before it finished, so its result cannot be trusted: ${s(p, "error")}. Nothing has been judged by that check. The program officer decides how to proceed and may ask the technical team to look at it.`,

  DUPLICATE_ID: (p) =>
    `The name "${s(p, "id")}" is used by more than one item (${s(p, "kinds")}), so the draft could be read in two ways. The booklet is not involved. The program officer decides which item keeps the name.`,

  UNKNOWN_VARIABLE: (p) =>
    `${cap(s(p, "item"))} depends on "${s(p, "variable")}", but the draft has no such question or calculated value (${s(p, "where")}). The booklet is not involved. The program officer decides whether the item should use another question or be removed.`,

  RELEVANCE_READS_DERIVED: (p) =>
    `The condition deciding when "${s(p, "question")}" is asked uses the calculated value "${s(p, "derived")}", but only answers to questions may be used there. The booklet is not involved. The program officer decides which question it should use.`,

  UNKNOWN_OUTCOME: (p) =>
    `${cap(s(p, "item"))} points to the result "${s(p, "outcome")}", which is not in the list of results the draft declares. The booklet is not involved. The program officer decides whether the result is missing or the item is wrong.`,

  TYPE_MISMATCH: (p) =>
    `${cap(s(p, "item"))} compares "${s(p, "variable")}" with ${s(p, "got")}, but this question takes ${s(p, "expected")}. The booklet is not involved. The program officer decides which side is wrong.`,

  OPERATOR_MISUSE: (p) =>
    `${cap(s(p, "item"))} tests "${s(p, "variable")}" in a way that does not suit its kind of answer: ${s(p, "problem")}. The booklet is not involved. The program officer decides how the test should be written.`,

  SOURCE_DOCUMENT_MISSING: (p) =>
    `The booklet text was not supplied, so the ${s(p, "what")} could not be checked against it. Nothing has been confirmed. The program officer decides how to proceed, which is normally to run the checks again with the booklet attached.`,

  EMPTY_QUOTE: (p) =>
    `The source shown for ${s(p, "item")} has no words in it, so nobody can see what the booklet says (cited: ${pageText(p)}). The program officer corrects the citation, or asks the clinician if the item itself may be invented.`,

  HALLUCINATED_CITATION: (p, a) =>
    `The words given as the source for ${s(p, "item")} cannot be found on the booklet page it points to. The closest passage on ${pageText(p)} says: "${s(p, "blockText")}". The draft quotes: "${s(p, "quote")}". ${
      a === "clinician"
        ? "The program officer first checks for a wrong citation, and asks the clinician if the item itself may have been invented."
        : "The program officer decides: fix the citation, or, if the item itself may be invented, send it to the clinician."
    }`,

  QUOTE_TOO_SHORT: (p) =>
    `The source given for ${s(p, "item")} is only "${s(p, "quote")}" (${pageText(p)}). So few words could be found almost anywhere in the booklet and prove nothing. The program officer replaces it with the full booklet passage that supports the item.`,

  QUOTE_DROPS_NEGATION: (p, a) =>
    `The words given as the source for ${s(p, "item")} leave out a "not" (or "no", "without") that stands just before them in the booklet, so the quote says the opposite of the booklet. The booklet (${pageText(p)}) says: "${s(p, "blockText")}". The draft quotes: "${s(p, "quote")}". ${
      a === "clinician" ? "The clinician checks whether the item itself has the meaning reversed." : "The clinician checks whether the item itself has the meaning reversed; the program officer then corrects the quote."
    }`,

  SOURCE_PAGE_MISSING: (p) =>
    `${cap(s(p, "item"))} cites ${pageText(p)} of the booklet, but the uploaded booklet has no such page. The booklet cannot be used to check this item. The program officer corrects the citation.`,

  GUIDELINE_FILE_MISMATCH: (p) =>
    `This logic model was written from a different copy of the guideline than the one uploaded (the draft says it used "${s(p, "title")}", ${s(p, "edition")}). Quotes and numbers may not match the uploaded pages. The program officer decides whether to upload the right copy or to ask for the draft to be produced again from this one.`,

  TEAM_VALUE: (p, a) =>
    `${cap(s(p, "item"))} has numbers the team chose, with no booklet source: ${s(p, "usage")}. The booklet was not used to check them. ${
      a === "clinician" ? "The clinician confirms that they are right." : "The clinician confirms that they are right; the program officer passes them on."
    }`,

  CLINICIAN_VALUE: (p, a) =>
    `${cap(s(p, "item"))} has numbers the clinician decided (its origin is "clinician"), with no booklet quote: ${s(p, "usage")}. The booklet was not used to check them. This is for information. ${
      a === "clinician" ? "These numbers rest on the clinician's word." : "These numbers rest on the clinician's word; the program officer does not need to find a booklet source for them."
    }`,

  ENTRY_LIMIT_TEAM_CHOICE: (p) =>
    `The limits on what a health worker may type in were chosen by the team, not taken from the booklet: ${s(p, "limits")}. The booklet was not used to check them. This is for information; the clinician says whether they are sensible.`,

  RELEVANCE_READS_LATER_QUESTION: (p) =>
    `The condition deciding when "${s(p, "question")}" is asked uses the answer to "${s(p, "later")}", which is asked later or is the same question, so the answer is not known yet. The booklet is not involved. The program officer decides which earlier question it should use or whether the order should change.`,

  DERIVED_CYCLE: (p) =>
    `${cap(s(p, "item"))} depends on itself, directly or through other calculated values, so it can never be worked out. The booklet is not involved. The program officer decides which dependency to remove.`,

  UNKNOWN_AFFECTED_ITEM: (p) =>
    `${cap(s(p, "item"))} says it affects "${s(p, "target")}", which is not a question, calculated value, result or rule in the draft. The booklet is not involved. The program officer decides which item was meant.`,

  SCOPE_RULE_MISMATCH: (p) =>
    `${cap(s(p, "item"))} is meant for children outside the covered ages (${s(p, "lo")} up to ${s(p, "hi")} months), but it does not match that range: ${s(p, "problem")}. The booklet is not involved. The program officer asks the clinician which is right, the covered ages or the rule.`,

  // ---------- red team 1 (logic checks) ----------

  SCOPE_RULE_MISSING: (p) =>
    `The draft covers children aged ${s(p, "lo")} up to ${s(p, "hi")} months, and a younger or older child can be entered (for example ${s(p, "example")} months), but no rule handles children outside that range. Such a child would go through this form as if it applied to them. The booklet is not involved. The clinician decides what such a child should get; the program officer then adds the rule.`,

  AGE_QUESTION_MISSING: (p) =>
    `The draft covers an age range, but ${s(p, "problem")}, so the age groups, the dose tables and the rule for children outside the range cannot be checked. The booklet is not involved. The program officer makes the age question a whole-number question measured in "months".`,

  AGE_LIMITS_EXCLUDE_SCOPE: (p) =>
    `The draft covers children aged ${s(p, "lo")} up to ${s(p, "hi")} months, but the question "${s(p, "question")}" only accepts ${s(p, "min")} to ${s(p, "max")} months, so some children the booklet covers cannot be entered at all. The booklet is not involved. The program officer widens the entry limits, or asks the clinician whether the covered ages are wrong.`,

  ENTRY_LIMIT_HIDES_CUTOFF: (p) =>
    `${cap(s(p, "item"))} uses the cut-off ${s(p, "value")}${s(p, "unit")} for "${s(p, "question")}", but a health worker may only enter ${s(p, "min")} to ${s(p, "max")}${s(p, "unit")}, so ${s(p, "effect")}. ${bookletOpt(p)} The clinician decides whether the cut-off or the entry limits are wrong; the program officer then corrects them.`,

  DOSE_TABLE_MISSING: (p) =>
    `${cap(s(p, "item"))} gives a medicine whose dose the booklet sets by age, but the draft has no dose for each age group, so the health worker is not told how much to give. ${booklet(p)} The clinician confirms the doses; the program officer then adds the dose for each age group.`,

  DANGER_SIGN_NOT_URGENT: (p) =>
    `The booklet lists "${s(p, "sign")}" as a danger sign, so a child with it must be referred urgently. But ${s(p, "child")} gets "${s(p, "outcome")}", which is not the most urgent result ("${s(p, "urgent")}"). ${booklet(p)} The clinician decides how the rules must change; the program officer then makes the change.`,

  DANGER_SIGN_CANNOT_BE_RECORDED: (p) =>
    `The booklet lists "${s(p, "sign")}" as a danger sign, but no child within the covered ages and the entry limits can be recorded with it in this draft (through "${s(p, "question")}"), so it can never lead to a referral. ${booklet(p)} The clinician decides how it should be asked; the program officer then corrects the question or its limits.`,

  DANGER_SIGN_ASKED_ONLY_SOMETIMES: (p) =>
    `The question "${s(p, "question")}" asks about the danger sign "${s(p, "sign")}", but it is only asked when ${s(p, "guard")}. A child for whom it is not asked is treated as not having the sign. ${booklet(p)} Danger signs must be looked for in every child. The clinician confirms; the program officer then makes the question always asked.`,

  DANGER_SIGN_QUESTION_UNKNOWN: (p) =>
    `The draft cites the danger sign "${s(p, "sign")}", but no question can be found that asks about it, so it cannot be checked that the sign leads to an urgent referral. ${booklet(p)} The program officer adds the booklet passage to the question that asks about this sign, or asks the clinician whether the sign is missing.`,

  DANGER_SIGN_OUTCOME_NO_REFERRAL: (p) =>
    `A child with the danger sign "${s(p, "sign")}" gets the result "${s(p, "outcome")}", but none of its instructions tells the health worker to refer the child. ${booklet(p)} The clinician decides what the result must say; the program officer then adds the referral instruction from the booklet.`,

  DANGER_SIGN_EXCLUDED_COUGH_RELEVANT: (p) =>
    `The danger sign "${s(p, "sign")}" is listed as left out of this form, but the reading of the booklet marked it as related to cough, so a child with cough and this sign would not be referred.${s(p, "openQuestion") === "" ? "" : ` See the open question ${s(p, "openQuestion")}.`} ${booklet(p)} The clinician decides whether it must be asked; the program officer then adds it, or records why it is safe to leave out.`,

  SEVERITY_DANGER_NOT_TOP: (p) =>
    `The result "${s(p, "outcome")}" is what a child with a danger sign gets, but it is ranked ${s(p, "severity")} on the urgency scale, below the most urgent rank used in the draft (${s(p, "top")}; 1 is the most urgent). A referral for a danger sign must be among the most urgent results. The booklet is not involved. The clinician decides the ranking; the program officer then corrects it.`,

  SEVERITY_NOT_SEPARATED: (p) =>
    `The result "${s(p, "milder")}" is ranked ${s(p, "milderSeverity")} on the urgency scale, as urgent as or more urgent than "${s(p, "outcome")}" (ranked ${s(p, "severity")}), which is what a child with a danger sign gets (1 is the most urgent). The checks that look for urgent results hidden by less urgent ones cannot tell them apart. The booklet is not involved. The clinician decides the ranking; the program officer then corrects it.`,

  SEVERITY_ALL_EQUAL: (p) =>
    `All ${s(p, "count")} results of the draft are ranked ${s(p, "severity")} on the urgency scale, so nothing in the draft says which results are more urgent, and the checks for urgent results hidden by less urgent ones cannot work. The booklet is not involved. The clinician ranks the results; the program officer then records the ranking.`,

  URGENT_OVERLAP_UNTESTED: (p) =>
    `Two results that are equally urgent can both apply to the same child: for example ${s(p, "child")} gets "${s(p, "firstOutcome")}" from ${s(p, "firstRule")}, although ${s(p, "overriddenRule")} would give "${s(p, "overriddenOutcome")}". The urgency ranking cannot tell which is right, and no test case checks it. The booklet is not involved. The clinician adds a test case for such a child with the result they expect.`,

  FOLLOWUP_REQUIRED_BY_SOURCE: (p) =>
    `${cap(s(p, "item"))} has no follow-up, yet ${s(p, "where")} says to follow up the child ("${s(p, "says")}"). Nobody would be reminded to check on the child. ${bookletOpt(p)} The clinician confirms the follow-up; the program officer then adds it.`,

  FOLLOWUP_KIND_MISMATCH: (p) =>
    `${cap(s(p, "item"))} is set up as a follow-up for when the child comes back, but ${s(p, "where")} says to follow up after a fixed number of days ("${s(p, "says")}"). No reminder would be created, so the child might not be checked on. ${bookletOpt(p)} The clinician decides; the program officer then makes it a follow-up after that number of days.`,

  FOLLOWUP_DUE_SAME_DAY: (p) =>
    `${cap(s(p, "item"))} is due after 0 days, the same day as the visit, so the reminder would come up straight away instead of on the day the child should be checked again. ${bookletOpt(p)} The clinician decides the right number of days.`,

  UNGROUNDED_NUMBER: (p, a) => {
    if (s(p, "pageQuote") !== "") {
      return `${cap(s(p, "item"))} uses the number ${s(p, "number")}, but it is not written in any of the quotes given for this item. ${booklet(p)} The draft has ${s(p, "usage")}. The cited ${pageText(p)} does carry the number: "${s(p, "pageQuote")}". ${
        a === "program_officer"
          ? 'The program officer adds that passage as a further quote of this item (or corrects the citation). The clinician then confirms the number.'
          : "The program officer adds that passage as a further quote of this item (or corrects the citation); the clinician then confirms the number."
      }`;
    }
    const unitHint =
      s(p, "reason") === "no_unit"
        ? `The number ${s(p, "number")} does appear, but not next to a matching unit (${s(p, "expectedUnit")}).`
        : `The number ${s(p, "number")} does not appear in the quotes given for this item, nor on the cited page.`;
    return `${cap(s(p, "item"))} uses a number that the booklet passage cited for it does not support. ${unitHint} ${booklet(p)} The draft has ${s(p, "usage")}. ${
      a === "clinician" ? ASK_CLINICIAN : `${ASK_CLINICIAN} The program officer first checks that the right passage is cited.`
    }`;
  },

  UNIT_MISMATCH: (p, a) =>
    `${cap(s(p, "item"))} uses ${s(p, "usage")}, but the booklet gives that number with a different unit (${s(p, "textUnits")}). ${booklet(p)} The draft has ${s(p, "usage")}. ${
      a === "clinician" ? ASK_CLINICIAN : `${ASK_CLINICIAN} The program officer first checks that the right passage is cited.`
    }`,

  NUMBER_CONTEXT_MISMATCH: (p, a) =>
    `${cap(s(p, "item"))} uses ${s(p, "usage")}. The number ${s(p, "number")} is in a quote given for it, but that passage is about something else: it does not mention ${s(p, "concept")}. ${booklet(p)} A number may only be taken from a passage about the same thing. ${
      a === "clinician" ? ASK_CLINICIAN : `${ASK_CLINICIAN} The program officer first checks that the right passage is cited.`
    }`,

  NUMBER_PAIRING_MISMATCH: (p, a) =>
    `${cap(s(p, "item"))} uses ${s(p, "usage")}. Each of these numbers (${s(p, "numbers")}) is in the booklet, but not together in the same passage for the same age band, so a number may have been moved to the wrong age band. ${booklet(p)} ${
      a === "clinician" ? "The clinician checks which number goes with which age band." : "The program officer asks the clinician which number goes with which age band."
    }`,

  NUMBER_IN_TEXT_UNSUPPORTED: (p, a) =>
    `The words shown to the health worker for ${s(p, "item")} ("${s(p, "text")}") contain ${s(p, "numbers")}, which none of the quotes given for it carries. ${booklet(p)} A dose, a cut-off or a number of days in the wording must come from the booklet. ${
      a === "clinician" ? "The clinician corrects the wording or confirms the number." : "The program officer asks the clinician to correct the wording or confirm the number."
    }`,

  TEAM_THRESHOLD_UNCONFIRMED: (p, a) =>
    `${cap(s(p, "item"))} decides a result with numbers the team chose, with no booklet source: ${s(p, "usage")}. Numbers like these could replace the booklet's cut-offs unseen, so the item stays blocked until a clinician has answered an open question about it (one that names "${s(p, "id")}" and writes each of these numbers). ${
      a === "clinician" ? "The clinician confirms or corrects the numbers and records the answer." : "The program officer adds an open question for the clinician about these numbers."
    }`,

  NUMBER_UNIT_CONVERTED: (p) =>
    `${cap(s(p, "item"))} uses ${s(p, "usage")}, while the booklet gives the same amount in another unit: ${s(p, "derivation")}. ${booklet(p)} The draft has ${s(p, "usage")}. This is for information; the clinician may confirm the conversion if in doubt.`,

  GUIDELINE_DEVIATION: (p) =>
    `${cap(s(p, "item"))} uses ${s(p, "usage")}, which the booklet does not support. ${booklet(p)} The draft has ${s(p, "usage")}. This is a recorded decision by ${s(p, "by")} to differ from the booklet: "${s(p, "note")}". The clinician remains responsible for it.`,

  // ---------- logic analysis (T9a) ----------

  TABLE_NOT_CLOSED: (p, a) =>
    `The rules do not end with a catch-all rule that applies to every child left over (${s(p, "problem")}), so some children could be left without any result. The booklet is not involved. ${
      a === "clinician" ? "The clinician chooses what such a child should get, and the program officer adds the catch-all rule." : "The clinician chooses what such a child should get; the program officer then adds the catch-all rule."
    }`,

  UNCOVERED_ANSWERS: (p, a) =>
    `${s(p, "count")} combinations of answers get no result from any rule, for example ${s(p, "child")}. Nothing would tell the health worker what to do for such a child. The booklet is not involved. ${
      a === "clinician" ? "The clinician decides what these children should get." : "The program officer asks the clinician what these children should get."
    }`,

  NOT_PROVEN: (p) =>
    `It could not be shown that every combination of answers gets a result: ${s(p, "reason")}. The other results of the checks only hold for the combinations that were looked at. The booklet is not involved. The program officer decides how to proceed, usually by simplifying the draft or asking the technical team.`,

  SHADOWED_RULE: (p, a) =>
    `${cap(s(p, "item"))} is never the one that decides: wherever it applies, ${s(p, "winner")} is checked first and decides instead. For example ${s(p, "child")} is decided by ${s(p, "winner")}. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides whether the order of the rules is wrong or the rule is not needed." : "The program officer asks the clinician whether the order of the rules is wrong or the rule is not needed."
    }`,

  UNREACHABLE_RULE: (p, a) =>
    `${cap(s(p, "item"))} can never decide for any child. ${
      s(p, "why") === "hidden"
        ? `Every child it applies to is already decided by a rule checked before it${s(p, "winner") === "" ? "" : ` (for example ${s(p, "winner")})`}.`
        : "No child within the entry limits can meet its conditions."
    } ${bookletOpt(p)} The draft contains this rule. ${a === "clinician" ? "The clinician decides whether the rule or the rules around it are wrong." : "The program officer asks the clinician whether the rule or the rules around it are wrong."}`,

  UNREACHABLE_OUTCOME: (p, a) =>
    `No child can get the result "${s(p, "outcome")}": no rule that can decide gives it${
      p["hasFollowUp"] === true ? ", so its follow-up (the check on the child later) can never be set up either" : ""
    }. The booklet is not involved. ${a === "clinician" ? "The clinician decides whether a rule is missing or the result is not needed." : "The program officer asks the clinician whether a rule is missing or the result is not needed."}`,

  QUESTION_NEVER_SHOWN: (p) =>
    `The question "${s(p, "question")}" can never be asked: the conditions for asking it cannot be met by any child within the entry limits. The booklet is not involved. The program officer decides whether the condition or the question is wrong.`,

  DERIVED_CONSTANT: (p, a) =>
    `The calculated value "${s(p, "item")}" is always ${s(p, "always")}, whatever the answers, so it never separates children. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides whether its definition is wrong." : "The program officer asks the clinician whether its definition is wrong."
    }`,

  DEAD_INPUT: (p, a) =>
    `The health worker is asked "${s(p, "item")}", but no answer to it ever changes the result. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides whether the question is needed, or a rule that should use it is missing." : "The program officer asks the clinician whether the question is needed, or a rule that should use it is missing."
    }`,

  USE_BEFORE_ASK: (p) =>
    `${cap(s(p, "item"))} uses the answer to "${s(p, "question")}", but that question is not asked for every child (it is only asked when ${s(p, "guard")}), and the rule does not first make sure it was asked. For example ${s(p, "child")} is never asked it, so it counts as not answered, although an answer of ${s(p, "answer")} would have made this condition true. ${bookletOpt(p)} The program officer decides how to fix it, normally by requiring the question to be asked first.`,

  SEVERITY_INVERSION: (p, a) =>
    `A less urgent result can hide a more urgent one. For example ${s(p, "child")} gets "${s(p, "firstOutcome")}" from ${s(p, "firstRule")}, although ${s(p, "overriddenRule")} also applies and would give the more urgent "${s(p, "overriddenOutcome")}", because ${s(p, "firstRule")} is checked first.${
      s(p, "openQuestion") === "" ? "" : ` This is the open question ${s(p, "openQuestion")}.`
    } ${bookletOpt(p)} ${
      a === "clinician"
        ? "The clinician decides: change the order, or approve the exception and record why."
        : "The program officer sends this to the clinician, who changes the order or approves the exception and records why."
    }`,

  SEVERITY_EXCEPTION_APPROVED: (p) =>
    `${cap(s(p, "firstRule"))} is checked before ${s(p, "overriddenRule")} although it gives the less urgent result ("${s(p, "firstOutcome")}" instead of "${s(p, "overriddenOutcome")}"), for example for ${s(p, "child")}. This was approved by ${s(p, "by")}: "${s(p, "note")}". This is for information; the clinician remains responsible for it.`,

  REQUIRED_QUESTION_OPTIONAL: (p) =>
    `The question "${s(p, "question")}" decides the result (${s(p, "item")}), but the health worker may skip it. A skipped answer is treated as normal, so a child whose sign was not looked for is handled as if the sign were absent. ${bookletOpt(p)} The clinician decides whether it must be asked every time; the program officer then makes it required.`,

  UNMEASURABLE_NOT_SUPPORTED: (p) =>
    `Some questions need a count or a measurement: ${s(p, "questions")}. If it could not be measured (for example the child will not keep still for the count), the form has no way to record that, and the health worker must invent a number or leave it out, which is then treated as normal. This is for information; the clinician says what should happen when it could not be measured.`,

  AGE_GAP: (p, a) =>
    `${cap(s(p, "where"))} leave out children aged ${s(p, "from")} up to ${s(p, "to")} months: no age band applies to them. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides which band they belong to." : "The program officer asks the clinician which band they belong to."
    }`,

  OUTSIDE_AGE_BANDS_MISMATCH: (p, a) =>
    `${cap(s(p, "where"))} are meant for children outside the covered ages (${s(p, "lo")} up to ${s(p, "hi")} months), but they leave out children aged ${s(p, "range")}: such a child would be treated as if this form applied to them. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides which ages are meant to be outside." : "The program officer asks the clinician which ages are meant to be outside."
    }`,

  AGE_OVERLAP: (p, a) =>
    `${cap(s(p, "where"))} count children aged ${s(p, "from")} up to ${s(p, "to")} months in two age bands at once, so they could get two different answers. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides which band they belong to." : "The program officer asks the clinician which band they belong to."
    }`,

  DOSE_BANDS_MISMATCH: (p, a) =>
    `The doses in ${s(p, "item")} are given for different age bands (${s(p, "doseBands")}) than the ones used to decide fast breathing (${s(p, "ruleBands")}), so a child could be given a dose for the wrong age. ${bookletOpt(p)} ${
      a === "clinician" ? "The clinician decides which bands are right." : "The program officer asks the clinician which bands are right."
    }`,

  BOUNDARY_SHOWN: (p) =>
    `Edge check for "${s(p, "question")}" at ${s(p, "threshold")}${s(p, "unit")}: for ${s(p, "child")}, ${s(p, "below")} gives "${s(p, "o1")}", ${s(p, "at")} gives "${s(p, "o2")}" and ${s(p, "above")} gives "${s(p, "o3")}".${
      p["bandsMeet"] === true
        ? ` This is where two age bands meet, so a child of exactly ${s(p, "threshold")} months is counted in the older band${s(p, "openQuestion") === "" ? "" : ` (see the open question ${s(p, "openQuestion")})`}.`
        : ""
    } ${bookletOpt(p)} This is for information; the clinician checks that each result is the intended one.`,

  // ---------- approval checks (T9b) ----------

  OPEN_QUESTION: (p) =>
    `Open question ${s(p, "id")} has not been answered: ${s(p, "question")} ${bookletOpt(p)} It concerns ${s(p, "affects") === "" ? "the draft as a whole" : s(p, "affects")}. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} decides the answer and records it before the draft can be signed.`,

  OPEN_QUESTION_NO_RESOLUTION: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") is marked as answered, but no answer is written down, so nobody can see what was decided. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} writes the answer in, or reopens the question.`,

  // ---------- open-question answers and who gave them (DEC-020) ----------

  OPEN_QUESTION_TRIVIAL_RESOLUTION: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") is marked as answered, but the answer written down ("${s(p, "resolution")}") does not say what was decided. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} writes the answer in full sentences, or reopens the question.`,

  OPEN_QUESTION_REMOVED: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") was in an earlier version of this draft and is gone from this one. Taking a question out does not answer it. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} puts it back and answers it.`,

  OPEN_QUESTION_REROUTED: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") was first sent to the ${s(p, "route") === "clinician" ? "clinician" : "program officer"} and is now marked for the ${s(p, "now") === "clinician" ? "clinician" : "program officer"}. Who answers a question cannot be changed by editing the draft. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} answers it.`,

  OPEN_QUESTION_WRONG_RESOLVER: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") is for the ${s(p, "route") === "clinician" ? "clinician" : "program officer"}, but its answer was written in version ${s(p, "version")}, which was saved ${s(p, "savedAs") === "" ? "without saying who saved it" : `by the ${s(p, "savedAs") === "clinician" ? "clinician" : "program officer"}`}. The ${s(p, "route") === "clinician" ? "clinician" : "program officer"} writes the answer in their own version.`,

  OPEN_QUESTION_CLINICIAN_NOT_RECORDED: (p) =>
    `Open question ${s(p, "id")} ("${s(p, "question")}") was answered in version ${s(p, "version")}, but that version does not record the clinician's name and a note saying what was changed. The clinician saves the answer again with their name and a short change note.`,

  RESERVED_FIELD_NAME: (p) =>
    `The name "${s(p, "name")}" given to ${s(p, "item")} is one that the form builder or the health platform keeps for itself (${s(p, "because")}), so the form could break or mix up data. The booklet is not involved. The program officer chooses another name for it.`,

  INVALID_FIELD_NAME: (p) =>
    `The name "${s(p, "name")}" given to ${s(p, "item")} cannot be used in the form: ${s(p, "problem")}. A name must start with a lowercase letter, use only lowercase letters, digits and underscores, and be at most 32 characters long. The booklet is not involved. The program officer chooses a name that follows these rules.`,

  FIELD_RENAMED: (p) =>
    `${cap(s(p, "item"))} ("${s(p, "name")}") is in the version that health workers already use, but it is gone or renamed in this draft. Reports already filled in under the old name would no longer match the new form, and their answers could be lost or misread by anyone looking at existing reports. The booklet is not involved. ${
      s(p, "confirmer") === "clinician"
        ? "The clinician confirms that the change does not alter the meaning of the answers already recorded."
        : "The program officer confirms with the technical team that existing reports are looked after, or keeps the old name."
    }`,

  FOLLOWUP_MISSING_OUTCOME: (p) =>
    `${cap(s(p, "item"))} sends the child to be referred, but it has no follow-up at all, so nobody is asked to check on the child later. ${bookletOpt(p)} The clinician decides whether a follow-up is missing; the program officer then adds it.`,

  FOLLOWUP_INVALID_DAYS: (p) =>
    `${cap(s(p, "item"))} has ${s(p, "what")} of ${s(p, "value")} days, which is below zero and cannot be put in a calendar. ${bookletOpt(p)} The clinician decides the right number of days.`,

  FOLLOWUP_RETURN_DAYS_IGNORED: (p) =>
    `${cap(s(p, "item"))} is a follow-up for when the child comes back, but it also carries ${s(p, "days")} days. The form does not use that number, because for a return visit nobody knows the date. ${bookletOpt(p)} This is for information; the clinician says how the return date will be known, or whether it should be a follow-up after a fixed number of days.`,

  CLINICAL_TEXT_MISSING: (p) =>
    `${cap(s(p, "item"))} tells the health worker nothing to do: none of its actions has any words. ${bookletOpt(p)} A result without instructions leaves the health worker without guidance. The clinician decides what the text should say; the program officer then adds it.`,

  CLINICAL_TEXT_UNSOURCED: (p) =>
    `${cap(s(p, "item"))} sends the child to be referred, but none of its instructions is taken from the booklet with a quote. Referral instructions must come from the guideline. The clinician decides whether the wording is right; the program officer then adds the booklet passage it comes from.`,

  TEAM_TEXT_TO_CONFIRM: (p) =>
    `${cap(s(p, "item"))} contains wording the team wrote itself, not taken from the booklet: ${s(p, "texts")}. The booklet was not used to check it. This is for information; the clinician confirms that the wording is right.`,

  TEXT_NEGATION_MISMATCH: (p, a) =>
    `The words shown to the health worker for ${s(p, "item")} ("${s(p, "text")}") ${s(p, "says")}, but the booklet passage cited for it ${s(p, "booklet")}, so the wording may say the opposite of the booklet. ${booklet(p)} ${
      a === "clinician" ? "The clinician decides which wording is right." : "The program officer asks the clinician which wording is right."
    }`,

  TEXT_OFF_TOPIC: (p, a) =>
    `The words shown to the health worker for ${s(p, "item")} ("${s(p, "text")}") share no telling word with the booklet passage cited for it, so they may be about something else. ${booklet(p)} ${
      a === "clinician" ? "The clinician decides whether the wording matches the booklet." : "The program officer asks the clinician whether the wording matches the booklet, or corrects the citation."
    }`,

  AI_WORDED_TEXT: (p) =>
    `${s(p, "count")} ${p["count"] === 1 ? "piece" : "pieces"} of wording shown to the health worker ${p["count"] === 1 ? "is" : "are"} not the booklet's own words; the AI or the team wrote ${p["count"] === 1 ? "it" : "them"}: ${s(p, "texts")}${
      Number(p["more"] ?? 0) > 0 ? `, and ${s(p, "more")} more` : ""
    }. The booklet was used to check numbers and "not" in them, but not their meaning. The clinician reads each one and confirms that it says what the booklet says.`,

  DANGER_SIGN_NOT_MODELLED: (p) =>
    `The booklet lists the danger sign "${s(p, "sign")}", but the draft neither asks about it nor says it is left out. ${booklet(p)} ${
      p["coughRelevant"] === true ? "The reading of the booklet marked it as related to cough." : "The reading of the booklet marked it as not related to cough, but the draft does not say so."
    } A child with this sign could be sent home as if healthy.${s(p, "openQuestion") === "" ? "" : ` See the open question ${s(p, "openQuestion")}.`} The clinician decides whether it belongs in this form; the program officer then adds it, or lists it as left out and says why.`,

  DANGER_SIGN_EXCLUDED_NOT_COUGH: (p) =>
    `The danger sign "${s(p, "sign")}" is not asked about in this form. ${
      p["coughRelevant"] === true
        ? "The reading of the booklet marked it as related to cough, yet the draft lists it as left out."
        : "The reading of the booklet marked it as not related to cough, and the draft lists it as left out."
    } ${booklet(p)} A child with cough who also has this sign would not be sent for referral by this form.${s(p, "openQuestion") === "" ? "" : ` See the open question ${s(p, "openQuestion")}.`} This is for information; the clinician confirms that it is safe to leave it out.`,

  EXTRACTION_TEXT_LOOKS_LIKE_INSTRUCTION: (p) =>
    `The reading of the booklet contains text that looks like an instruction to the computer rather than guideline content (in ${s(p, "ids")}), for example: "${s(p, "example")}". It was treated as plain text and not followed, but it should not be there. The program officer checks the reading of the booklet and has it done again if it was tampered with.`,

  UNCITED_PASSAGE: (p) =>
    `On ${pageText(p)} of the booklet, ${s(p, "count")} passage${p["count"] === 1 ? " that contains" : "s that contain"} numbers or instructions ${p["count"] === 1 ? "is" : "are"} not used by any item of the draft, for example: ${s(p, "examples")}. They may belong to another pathway, or the draft may have left something out. The program officer marks each as out of scope, or sends it to the clinician.`,

  INCLUSIVITY_MISMATCH: (p) =>
    `${cap(s(p, "item"))}: the booklet says "${s(p, "sourcePhrase")}", which ${s(p, "meaning")}, but the draft counts ${s(p, "usage")}. ${booklet(p)} A child with exactly ${s(p, "number")}${s(p, "unit")} would be handled differently from what the booklet says. The clinician decides which is right; the program officer then corrects the draft.`,

  DIRECTION_MISMATCH: (p) =>
    `${cap(s(p, "item"))}: the booklet says "${s(p, "sourcePhrase")}", which is about children ${s(p, "bookletSide")}, but the draft counts the opposite side, ${s(p, "usage")}. ${booklet(p)} Children on one side of ${s(p, "number")}${s(p, "unit")} would be handled as if they were on the other. The clinician decides which is right; the program officer then corrects the draft.`,

  INCLUSIVITY_ASSUMED: (p) =>
    `${cap(s(p, "item"))}: the booklet says "${s(p, "sourcePhrase")}". The draft reads this as: ${s(p, "reading")}. ${booklet(p)} That reading is the team's, the booklet does not spell it out.${s(p, "openQuestion") === "" ? "" : ` See the open question ${s(p, "openQuestion")} for a child of exactly that value.`} This is for information; the clinician confirms the reading.`,

  COMPILE_NOT_READY: (p) =>
    `The form cannot be built yet. Missing: ${s(p, "missing")}. The booklet is not involved. The program officer supplies these before the draft is turned into a form.`,

  FOLLOWUP_NOT_COMPILED: (p) =>
    `${cap(s(p, "item"))} is a follow-up for when the child comes back, and the form builder will not create a reminder for it, because there is no date to count from. ${bookletOpt(p)} The clinician says how the return date will become known (for example, the health worker enters it at the first visit), or whether a fixed number of days should be used instead.`,

  TEAM_DEFAULT_WINDOW: (p) =>
    `${cap(s(p, "item"))} is due after ${s(p, "due")} days, but neither the booklet nor the draft says how many days the task stays open after that. The form uses the team's default of ${s(p, "days")} days until this is answered${s(p, "openQuestion") === "" ? "" : ` (open question ${s(p, "openQuestion")})`}. The program officer confirms that number, or gets the right one from the clinician.`,

  GOLDEN_MISMATCH: (p) =>
    p["ruleOnly"] === true
      ? `Test case ${s(p, "id")} ("${s(p, "description")}") gets the result it expects, "${s(p, "actual")}", but through ${s(p, "rule")} instead of the ${s(p, "expectedRule")} that the case names. ${s(p, "note") === "" ? "" : `Note on the case: ${s(p, "note")}`} The clinician decides whether the draft or the test case is wrong.`
      : `Test case ${s(p, "id")} ("${s(p, "description")}") expects "${s(p, "expected")}" but the draft gives "${s(p, "actual")}", decided by ${s(p, "rule")}. ${s(p, "note") === "" ? "" : `Note on the case: ${s(p, "note")}`} The clinician decides whether the draft or the test case is wrong.`,

  GOLDEN_INVALID: (p) =>
    `Test case ${s(p, "id")} ("${s(p, "description")}") cannot be run: ${s(p, "problem")}. Nothing has been checked for this case. The clinician corrects the test case.`,

  GOLDEN_PENDING_CLINICIAN: (p) =>
    `${s(p, "count")} test case${p["count"] === 1 ? " is" : "s are"} still waiting for the clinician to confirm ${p["count"] === 1 ? "it" : "them"} (${s(p, "ids")}). Until then they show what the draft does, not what is right. This is for information; the clinician confirms each case.`,

  OUTCOME_WITHOUT_GOLDEN_CASE: (p) =>
    `No test case leads to ${s(p, "item")}, so nobody has checked that a child really gets this result. The clinician adds a test case for it, or says why none is needed.`,

  GOLDEN_COUNT: (p) =>
    `${s(p, "total")} test cases were run through the draft: ${s(p, "agree")} give the expected result and ${s(p, "different")} do not. This is for information; the cases only show that the draft does what the clinician expects, so they are as good as the cases themselves.`,

  CONTEXT_NOT_PROVIDED: (p) =>
    `Some checks did not run, because the information they need was not supplied: ${s(p, "checks")}. Nothing has been confirmed by them, so their silence is not a pass. The program officer supplies ${s(p, "needs")} and runs the checks again.`,
};

function cap(x: string): string {
  return x === "" ? x : x.charAt(0).toUpperCase() + x.slice(1);
}

/** Renders the plain-language message for a finding code. Throws for an unknown code. */
export function render(code: string, params: Params, audience: Audience): string {
  const t = TEMPLATES[code];
  if (t === undefined) throw new Error(`no message template for finding code ${code}`);
  return t(params, audience).replace(/ {2,}/g, " ").trim();
}

export const MESSAGE_CODES: readonly string[] = Object.keys(TEMPLATES);
