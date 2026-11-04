// Drives the built preview page in headless Chrome (playwright-core). Shared by screenshots and verify.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { PREVIEW_OUT, launchBrowser } from "./paths.mjs";

/** Logic-model answers (booleans, integers) -> form values ('yes'/'no', integers). */
export const toFormAnswers = (answers) =>
  Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "yes" : "no") : v]));

export async function openPreview({ viewport = { width: 1100, height: 1000 } } = {}) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  // file:// on purpose: proves the static copy works without a server.
  await page.goto(pathToFileURL(join(PREVIEW_OUT, "index.html")).href);
  await page.waitForFunction(() => window.previewApi && (window.previewApi.ready || window.previewApi.error), null, { timeout: 20000 });
  const err = await page.evaluate(() => window.previewApi.error);
  if (err) throw new Error(`preview failed to load: ${err}`);
  const api = {
    restart: () => page.evaluate(() => window.previewApi.start()),
    state: () => page.evaluate(() => window.previewApi.state()),
    fillPage: (answers) => page.evaluate((a) => window.previewApi.fillPage(a), answers),
    setQuestion: (name, value) => page.evaluate(([n, v]) => window.previewApi.setQuestion(n, v), [name, value]),
    // Click the real Next button, then wait for enketo's async page validation.
    next: async () => {
      const before = await page.evaluate(() => window.previewApi.state().page);
      await page.click("#form-wrap .btn.next-page");
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => window.previewApi.state().page);
      return after > before;
    },
    // One question per screen: fill the current page, press the real Next, repeat, and stop on the last
    // question page (the Result page is one more Next away). Returns the pages visited, in order.
    // Only screens that appear are answered: answers for questions the flow skips are never typed and
    // come back in notShown (the derived flow hides questions that cannot change the outcome).
    // opts.stopAfter: stop (without pressing Next) once this question has been answered.
    fillWizard: async (answers, opts = {}) => {
      const answered = [];
      const pages = [];
      for (let guard = 0; guard < 60; guard++) {
        const st = await page.evaluate(() => window.previewApi.state());
        if (st.page >= st.pages - 1) break; // the Result page
        const f = await page.evaluate((a) => window.previewApi.fillPage(a), answers);
        pages.push(f.answered);
        answered.push(...f.answered);
        if (opts.stopAfter && f.answered.includes(opts.stopAfter)) break;
        const after = await page.evaluate(() => window.previewApi.state());
        if (after.page >= after.pages - 2) break; // last question page: caller presses Next for Result
        const moved = await api.next();
        if (!moved) break;
      }
      const notShown = Object.keys(answers).filter((k) => !answered.includes(k));
      return { answered, pages, notShown };
    },
    firstPage: () => page.evaluate(() => window.previewApi.firstPage()),
    submit: () => page.evaluate(() => window.previewApi.submit()),
    evaluatePoints: (points) => page.evaluate((p) => window.previewApi.evaluatePoints(p), points),
  };
  return { browser, page, api, problems };
}
