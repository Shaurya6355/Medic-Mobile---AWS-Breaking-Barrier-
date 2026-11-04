import type { Decision, ItemId, Patch, Role, SuggestionOutcome } from "./domain/types";

/** Everything a screen can ask the app to do. App.tsx implements these by calling src/api. */
export interface Actions {
  createDraft: (args: { guidelineId: string; pathway: string; pages: number[] }) => Promise<void>;
  edit: (item: ItemId, field: string, patch: Patch) => void;
  send: () => void;
  decide: (item: ItemId, d: Decision | null) => void;
  flag: (flagId: string, choice: number, note: string) => void;
  returnToPO: () => void;
  sug: (item: ItemId, outcome: SuggestionOutcome) => void;
  approveAll: () => void;
  runVerify: () => void;
  approveDeploy: () => void;
  setRole: (r: Role) => void;
  reset: () => void;
}

export const ROLE_NAME: Record<Role, string> = { po: "Program officer", clinician: "Clinician", it: "IT approver" };
