// Captures PNGs of the compiled form, filled through its real inputs, into output/screenshots/.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUTPUT_DIR, SCREENSHOT_OUT, ensureDeps } from "./paths.mjs";

const NO_SIGNS = { convulsions: "no", not_able_to_drink_or_feed: "no", vomits_everything: "no", chest_indrawing: "no", unusually_sleepy: "no" };

const FAST = { age_months: 6, cough: "yes", cough_days: 3, ...NO_SIGNS, breaths_per_minute: 52 };

// One question per screen. kind "screen": fill the pages up to and including `upTo`, then capture that
// screen (optionally after pressing Next once more, `thenNext`); `expectQuestion` / `expectAbsent`
// check which question the screen shows. kind "result": fill every page, press Next, capture the Result page.
export const SCENARIOS = [
  { file: "02-age-answered.png", title: "Screen 1 (age): 6 typed, Next not yet pressed", answers: FAST, upTo: "age_months", expectQuestion: "age_months" },
  { file: "03-cough-screen.png", title: "Screen 2 (cough): shown after Next from age", answers: FAST, upTo: "age_months", thenNext: true, expectQuestion: "cough" },
  {
    file: "04-cough-no-skips-to-convulsions.png",
    title: "Cough = no, Next: the cough days screen is skipped, the next screen is convulsions (breaths screen will be skipped too)",
    answers: { age_months: 24, cough: "no", ...NO_SIGNS },
    upTo: "cough",
    thenNext: true,
    expectQuestion: "convulsions",
    expectAbsent: ["cough_days", "breaths_per_minute"],
  },
  { file: "05-cough-yes-cough-days-screen.png", title: "Cough = yes, Next: the cough days screen appears", answers: FAST, upTo: "cough", thenNext: true, expectQuestion: "cough_days" },
  { file: "06-last-question-screen.png", title: "Fast breathing child, last question screen (unusually sleepy), Next gives the Result page", answers: FAST, upTo: "unusually_sleepy", expectQuestion: "unusually_sleepy" },
  {
    file: "07-fast-breathing-result.png",
    title: "Fast breathing child (6 months, cough 3 days, 52 breaths, no signs): result page",
    answers: FAST,
    expect: "treat_fast_breathing_at_home",
  },
  {
    file: "08-danger-sign-result.png",
    title: "Danger sign child (as above plus convulsions = yes): result page",
    answers: { ...FAST, convulsions: "yes" },
    expect: "refer_urgent_with_antibiotic",
  },
  {
    file: "09-out-of-range-age-result.png",
    title: "Child aged 1 month (outside 2 to 59 months): result page",
    answers: { ...FAST, age_months: 1 },
    expect: "refer_outside_age_range",
  },
  {
    file: "10-no-cough-result.png",
    title: "Child with no cough (24 months): result page",
    answers: { age_months: 24, cough: "no", ...NO_SIGNS },
    expect: "no_cough",
  },
  {
    file: "11-constraint-error-breaths-5.png",
    title: "Constraint error: 5 breaths per minute (allowed 10 to 120), Next pressed on the breaths screen",
    answers: { ...FAST, breaths_per_minute: 5 },
    expectBlocked: true,
  },
  // Shortened flow (flowMode minimal only; the expected screens are the minimal flow's sequence).
  {
    file: "12-minimal-one-month-old-straight-to-result.png",
    title: "Minimal flow: a 1-month-old (with convulsions, cough...): after the age screen the form goes straight to the Result page (page 2 of 2)",
    answers: { ...FAST, age_months: 1, convulsions: "yes" },
    expect: "refer_outside_age_range",
    expectScreens: ["age_months"],
    expectPages: 2,
    onlyMode: "minimal",
  },
  {
    file: "13-minimal-convulsions-yes-next-is-chest-indrawing.png",
    title: "Minimal flow: convulsions = yes, Next: the drink/feed and vomiting screens are skipped, the next screen is chest indrawing",
    answers: { age_months: 24, cough: "yes", cough_days: 3, convulsions: "yes", chest_indrawing: "no", breaths_per_minute: 30 },
    upTo: "convulsions",
    thenNext: true,
    expectQuestion: "chest_indrawing",
    onlyMode: "minimal",
  },
  {
    file: "14-minimal-convulsions-yes-ends-early.png",
    title: "Minimal flow: child with cough and convulsions = yes: 6 screens (age, cough, cough days, convulsions, chest indrawing, breaths), then the Result page",
    answers: { age_months: 24, cough: "yes", cough_days: 3, convulsions: "yes", chest_indrawing: "no", breaths_per_minute: 30 },
    expect: "refer_urgent",
    expectScreens: ["age_months", "cough", "cough_days", "convulsions", "chest_indrawing", "breaths_per_minute"],
    expectPages: 7,
    onlyMode: "minimal",
  },
];

/** flowMode of the compiled form (compile:demo manifest); "full" if unknown. */
function compiledFlowMode() {
  const p = join(OUTPUT_DIR, "manifest.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).flow?.mode ?? "full") : "full";
}

export async function takeScreenshots({ quiet = false } = {}) {
  ensureDeps();
  const { openPreview } = await import("./driver.mjs");
  const log = quiet ? () => {} : console.log;
  rmSync(SCREENSHOT_OUT, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_OUT, { recursive: true });
  const { browser, page, api, problems } = await openPreview();
  const results = [];
  try {
    const shot = async (file) => {
      await page.screenshot({ path: join(SCREENSHOT_OUT, file), fullPage: true });
      log(`screenshot: output/screenshots/${file}`);
    };
    await shot("01-start.png");
    results.push({ file: "01-start.png", title: "Opening screen (age question, nothing answered)", ok: true });
    const mode = compiledFlowMode();
    for (const s of SCENARIOS) {
      if (s.onlyMode && s.onlyMode !== mode) {
        log(`skipped ${s.file}: only for flowMode ${s.onlyMode} (compiled: ${mode})`);
        continue;
      }
      await api.restart();
      let ok = true;
      let advanced = false;
      let pages = [];
      if (s.upTo) {
        const f = await api.fillWizard(s.answers, { stopAfter: s.upTo });
        pages = f.pages;
        if (s.thenNext) advanced = await api.next();
        else advanced = true;
      } else {
        const f = await api.fillWizard(s.answers);
        pages = f.pages;
        advanced = s.expectBlocked ? false : await api.next();
      }
      const st = await api.state();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(s.file);
      const shown = st.visibleQuestions.map((n) => n.split("/").pop());
      if (s.expect) ok = advanced && st.calcs.outcome === s.expect;
      if (s.expectScreens) ok = ok && JSON.stringify(pages.flat()) === JSON.stringify(s.expectScreens) && st.pages === s.expectPages && st.page === st.pages - 1;
      if (s.expectBlocked) ok = st.errors.length > 0 && !pages.flat().includes("unusually_sleepy");
      if (s.expectQuestion) ok = advanced && shown.length === 1 && shown[0] === s.expectQuestion && (s.expectAbsent ?? []).every((q) => !shown.includes(q));
      results.push({ file: s.file, title: s.title, ok, page: `${st.page + 1} of ${st.pages}`, shown, outcome: st.calcs.outcome, notes: st.visibleNotes.map((n) => n.name.split("/").pop()), errors: st.errors, pagesFilled: pages.map((p) => p.join("+")) });
    }
    // The flow diagram page renders offline (bundled mermaid, file://).
    const flowHtml = join(OUTPUT_DIR, "flow.html");
    if (existsSync(flowHtml)) {
      const fp = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
      await fp.goto(pathToFileURL(flowHtml).href);
      await fp.waitForFunction(() => document.body.dataset.rendered, null, { timeout: 30000 });
      const rendered = await fp.evaluate(() => document.body.dataset.rendered);
      const svgs = await fp.evaluate(() => document.querySelectorAll("pre.mermaid svg").length);
      await fp.screenshot({ path: join(SCREENSHOT_OUT, "15-flow-html.png"), fullPage: false });
      log("screenshot: output/screenshots/15-flow-html.png");
      await fp.evaluate(() => document.querySelector("#minimal .diagram").scrollIntoView());
      await fp.screenshot({ path: join(SCREENSHOT_OUT, "16-flow-diagram-minimal.png"), fullPage: false });
      log("screenshot: output/screenshots/16-flow-diagram-minimal.png");
      results.push({ file: "15-flow-html.png, 16-flow-diagram-minimal.png", title: "flow.html renders offline (both diagrams)", ok: rendered === "yes" && svgs === 2, rendered, svgs });
      await fp.close();
    }
  } finally {
    await browser.close();
  }
  if (problems.length) log("browser problems:\n" + problems.join("\n"));
  return { results, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results } = await takeScreenshots();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.file}${r.outcome ? ` outcome=${r.outcome}` : ""}${r.errors?.length ? ` errors=${JSON.stringify(r.errors)}` : ""}`);
  process.exit(bad.length ? 1 : 0);
}
