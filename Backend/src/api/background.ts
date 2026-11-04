import { withDeadline } from "../shutdown.js";

export type RunMode = "container" | "agentcore" | "lambda";

// Lambda freezes the process once the response is sent, so work started "in the
// background" would stall. In lambda mode wait for it (bounded by deadlineMs);
// elsewhere let it run on and only report a failure.
export const LAMBDA_BACKGROUND_DEADLINE_MS = 14 * 60 * 1000;

export async function runBackground(
  mode: RunMode,
  work: Promise<unknown>,
  onError: (err: unknown) => void,
  deadlineMs: number = LAMBDA_BACKGROUND_DEADLINE_MS,
  onDeadline: () => void = () => {},
): Promise<void> {
  const guarded = work.then(
    () => undefined,
    (e: unknown) => onError(e),
  );
  if (mode !== "lambda") return;
  if (!(await withDeadline(guarded, deadlineMs))) onDeadline();
}
