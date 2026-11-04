import { NotFound, artifactKey } from "../artifacts/artifactStore.js";
import type { Step } from "../engine/step.js";
import { Conflict } from "../store/store.js";
import type { LogicModelValidator } from "./logicModelValidator.js";

export function createFillLogicStep(opts: { validator: LogicModelValidator }): Step {
  return {
    name: "fill_logic",
    runState: "filling_logic",
    async run(ctx) {
      const runId = ctx.run.runId;

      // Version 1 is the only one this step may create. If it exists (for example a
      // crash after addVersion), succeed without touching it: a user may have extended it.
      const existing = async (): Promise<string | undefined> => {
        const versions = await ctx.store.listVersions(runId);
        if (versions.length === 0) return undefined;
        const v1 = versions.find((v) => v.n === 1);
        if (!v1) throw new Error(`Run ${runId} has versions but version 1 is missing`);
        return v1.artifactKey;
      };

      const found = await existing();
      if (found !== undefined) return { artifactRefs: { version: found } };

      const inKey = artifactKey(runId, "extract", "extraction_output.json");
      let output: unknown;
      try {
        output = JSON.parse(new TextDecoder().decode(await ctx.artifacts.get(inKey)));
      } catch (e) {
        if (e instanceof NotFound) throw new Error(`Extraction output not found at ${inKey}`);
        if (e instanceof SyntaxError) throw new Error(`Extraction output at ${inKey} is not valid JSON`);
        throw e;
      }

      const unclear =
        output !== null && typeof output === "object" && !Array.isArray(output)
          ? ((output as Record<string, unknown>).unclear_items ?? [])
          : [];
      const body = { placeholder: true, extraction: output, unclear };

      const result = opts.validator.validate(body);
      if (!result.ok) throw new Error(`Logic model failed validation: ${result.issues.join("; ")}`);

      // Artifact first, so a version never points at a missing object.
      const key = artifactKey(runId, "versions", "v1.json");
      await ctx.artifacts.put(key, JSON.stringify(body, null, 2), "application/json");
      try {
        await ctx.store.addVersion({ runId, n: 1, parent: null, author: "ai", createdAt: ctx.now(), artifactKey: key });
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        const winner = await existing();
        if (winner === undefined) throw e;
        return { artifactRefs: { version: winner } };
      }
      return { artifactRefs: { version: key } };
    },
  };
}
