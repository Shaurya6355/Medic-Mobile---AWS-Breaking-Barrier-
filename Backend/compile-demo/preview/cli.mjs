// Entry point for the Backend npm scripts:
//   node compile-demo/preview/cli.mjs preview       build the page from output/ and serve it (compile:preview)
//   node compile-demo/preview/cli.mjs build         build only (writes output/preview/)
//   node compile-demo/preview/cli.mjs screenshots   build, then capture output/screenshots/*.png
import { existsSync } from "node:fs";
import { FORM_XML, ensureDeps } from "./paths.mjs";

const cmd = process.argv[2] || "preview";
if (!existsSync(FORM_XML)) {
  console.error("No compiled form at compile-demo/output/project/forms/app/cough_fast_breathing.xml: run `npm run compile:demo` first.");
  process.exit(1);
}
ensureDeps();
const { buildPreview } = await import("./build-preview.mjs");
await buildPreview();
if (cmd === "preview") {
  const { startServer } = await import("./serve.mjs");
  await startServer();
  console.log("Static copy (no server needed): compile-demo/output/preview/index.html");
} else if (cmd === "screenshots") {
  const { takeScreenshots } = await import("./screenshots.mjs");
  const { results } = await takeScreenshots();
  for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.file}${r.outcome ? ` outcome=${r.outcome}` : ""}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
} else if (cmd !== "build") {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
