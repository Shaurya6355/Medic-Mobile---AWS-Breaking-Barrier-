import type { ItemId, Patch, Role } from "./domain/types";

/** Everything a screen can ask the app to do. App.tsx implements these by calling src/api. */
export interface Actions {
  createDraft: (args: { guidelineId: string; pathway: string; pages: number[] }) => Promise<void>;
  /** IT approver: open a clinician-approved (locked) run at Release. */
  openForRelease: (args: { guidelineId: string; pathway: string }) => Promise<void>;
  edit: (item: ItemId, field: string, patch: Patch) => void;
  undo: () => void;
  chat: (text: string) => void;
  /** Live only: send feedback to the AI (comment + plan). Then confirm or cancel the plan. */
  feedback: (text: string) => void;
  confirmRevision: (msgId: number) => void;
  cancelRevision: (msgId: number) => void;
  apply: (msgId: number, i: number) => void;
  dismiss: (msgId: number) => void;
  answer: (flagId: string, choice: "keep" | "change") => void;
  /** Resolves when done or failed (a failure shows in the error banner). Live mode saves and signs on the backend. */
  approveAll: () => Promise<void>;
  runVerify: () => void;
  approveDeploy: () => void;
  setRole: (r: Role) => void;
  reset: () => void;
}

export const ROLE_NAME: Record<Role, string> = { clinician: "Clinician", it: "IT approver" };
