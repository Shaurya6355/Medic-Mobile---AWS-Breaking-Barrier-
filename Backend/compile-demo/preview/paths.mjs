// Shared paths and small helpers for the preview tooling (node builtins only).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const PREVIEW_DIR = dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = resolve(PREVIEW_DIR, "..");
export const BACKEND_DIR = resolve(DEMO_DIR, "..");
export const OUTPUT_DIR = join(DEMO_DIR, "output");
export const PROJECT_DIR = join(OUTPUT_DIR, "project");
export const FORM_ID = "cough_fast_breathing";

export const FORM_XML = join(PROJECT_DIR, "forms", "app", `${FORM_ID}.xml`);
export const PREVIEW_OUT = join(OUTPUT_DIR, "preview");
export const SCREENSHOT_OUT = join(OUTPUT_DIR, "screenshots");
export const PORT = Number(process.env.PREVIEW_PORT || 5199);

/**
 * The cht-core checkout whose XSL stylesheets turn the XForm into enketo HTML + model, exactly as
 * cht-core's api does (api/src/services/generate-xform.js). Override with CHT_CORE_DIR.
 */
export function findChtCore() {
  const candidates = [
    process.env.CHT_CORE_DIR,
    resolve(BACKEND_DIR, "../../../AWS Breaking Barrier - 2026/Medic Mobile/repos/cht-core"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, "api/src/xsl/openrosa2html5form.xsl"))) return c;
  }
  throw new Error(
    "cht-core checkout not found. Set CHT_CORE_DIR to a cht-core clone (needs api/src/xsl and api/src/enketo-transformer). Tried: " +
      candidates.join(", "),
  );
}

/** Install the preview's own dependencies on first use (network needed once). */
export function ensureDeps() {
  if (existsSync(join(PREVIEW_DIR, "node_modules", "enketo-core", "package.json"))) return;
  console.log("preview: installing dependencies in compile-demo/preview (first run)...");
  const lock = existsSync(join(PREVIEW_DIR, "package-lock.json"));
  const r = spawnSync("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: PREVIEW_DIR, stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm install in compile-demo/preview failed");
}

/** A Chrome/Chromium executable for playwright-core: CHROME_PATH, the installed Google Chrome, or none. */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c));
}

export async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      "No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH (e.g. after `npx playwright install chromium`).",
    );
  }
  return chromium.launch({ executablePath, headless: true });
}
