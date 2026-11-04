import type { Model } from "../logic/index.js";
import type { RevisionComment } from "./types.js";

/**
 * The items the confirmed comments point at. Plain arrays of ids so it can be stored as JSON.
 *  - rules / outcomes / derived / questions: items whose content an edit may change.
 * A rule ref unlocks only that rule, an outcome ref only that outcome (neither unlocks the other).
 *  - openQuestions: commented open questions (read-only context; they are never changed).
 *  - unknown: item refs of comments that match nothing in the model.
 */
export interface TargetSet {
  rules: string[];
  outcomes: string[];
  derived: string[];
  questions: string[];
  openQuestions: string[];
  unknown: string[];
}

export const REF_KINDS = ["rules", "outcomes", "questions", "derived", "open_questions"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** "rules.R3" and "rules.R3.when" both give {kind:"rules", id:"R3"}. Undefined when the shape is wrong. */
export function parseItemRef(ref: string): { kind: RefKind; id: string } | undefined {
  const parts = ref.trim().split(".");
  const kind = parts[0] as RefKind;
  const id = parts[1];
  if (!REF_KINDS.includes(kind) || id === undefined || id === "") return undefined;
  return { kind, id };
}

export function allowedTargets(model: Model, comments: RevisionComment[]): TargetSet {
  const rules = new Set<string>();
  const outcomes = new Set<string>();
  const derived = new Set<string>();
  const questions = new Set<string>();
  const openQuestions = new Set<string>();
  const unknown = new Set<string>();

  for (const c of comments) {
    const ref = parseItemRef(c.itemRef);
    if (ref === undefined) {
      unknown.add(c.itemRef);
      continue;
    }
    switch (ref.kind) {
      case "rules": {
        const r = model.rules.find((x) => x.id === ref.id);
        if (r === undefined) unknown.add(c.itemRef);
        else rules.add(r.id);
        break;
      }
      case "outcomes": {
        const o = model.outcomes.find((x) => x.id === ref.id);
        if (o === undefined) unknown.add(c.itemRef);
        else outcomes.add(o.id);
        break;
      }
      case "derived":
        if (model.derived.some((x) => x.id === ref.id)) derived.add(ref.id);
        else unknown.add(c.itemRef);
        break;
      case "questions":
        if (model.questions.some((x) => x.id === ref.id)) questions.add(ref.id);
        else unknown.add(c.itemRef);
        break;
      case "open_questions":
        if (model.open_questions.some((x) => x.id === ref.id)) openQuestions.add(ref.id);
        else unknown.add(c.itemRef);
        break;
    }
  }
  const arr = (s: Set<string>): string[] => [...s].sort();
  return {
    rules: arr(rules),
    outcomes: arr(outcomes),
    derived: arr(derived),
    questions: arr(questions),
    openQuestions: arr(openQuestions),
    unknown: arr(unknown),
  };
}
