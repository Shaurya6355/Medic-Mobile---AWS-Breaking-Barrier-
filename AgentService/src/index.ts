import { createStrandsAgent } from "./agent.js";
import { DEFAULT_BODY_LIMIT_BYTES, buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const parsedLimit = Number(process.env.BODY_LIMIT_BYTES);
const bodyLimitBytes = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_BODY_LIMIT_BYTES;

const app = buildServer({
  createAgent: createStrandsAgent,
  region: process.env.AWS_REGION || "us-west-2",
  bodyLimitBytes,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);
  try {
    await app.close(); // stops accepting, waits for in-flight requests
    process.exit(0);
  } catch (e) {
    console.error("shutdown failed", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port });
console.log(`agent-service listening on 0.0.0.0:${port}`);
