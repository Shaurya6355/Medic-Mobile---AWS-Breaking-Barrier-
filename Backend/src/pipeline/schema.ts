/* The logic model is a pathway spec (shared/pathway/types.ts). Structure and semantics are checked by the
   shared compiler, the same code the review UI runs, so the two can't drift. */
export { validateSpec, type Diagnostic, type Spec as LogicModel } from "../../../shared/pathway/index.ts";
