// Form preview page: renders the cht-conf compiled form with enketo-core 7.2.5 (the engine of the
// CHT webapp), page by page, with CHT-style navigation, plus a side panel of preview tooling.
// Also exposes window.previewApi for the screenshot and verification scripts.
import $ from "jquery";
import { Form } from "enketo-core";

window.$ = window.jQuery = $;

const DATA = window.__PREVIEW_FORM__;
const ROOT = "/data";
const SYNTHETIC_CONTACT = { _id: "synthetic-child-0001", name: "Synthetic Child A", patient_id: "00001" };
const WATCH = ["fast_breathing", "danger_sign", "outcome"];

/** The instance a CHT form gets when opened from a contact's profile (EnketoPrepopulationDataService). */
function instanceFromContact(modelStr) {
  const doc = new DOMParser().parseFromString(modelStr, "text/xml");
  const data = doc.querySelector("instance > *");
  const set = (sel, v) => {
    const n = data.querySelector(sel);
    if (n) n.textContent = v;
  };
  set(":scope > inputs > source", "contact");
  set(":scope > inputs > contact > _id", SYNTHETIC_CONTACT._id);
  set(":scope > inputs > contact > name", SYNTHETIC_CONTACT.name);
  set(":scope > inputs > contact > patient_id", SYNTHETIC_CONTACT.patient_id);
  return new XMLSerializer().serializeToString(data);
}

/** Creates a fresh enketo Form inside `host` (like EnketoService.renderFromXmls in cht-core). */
function createForm(host) {
  host.innerHTML = DATA.formHtml;
  const formEl = host.querySelector("form");
  const form = new Form(formEl, { modelStr: DATA.model, instanceStr: instanceFromContact(DATA.model), external: [] }, { language: "en" });
  const loadErrors = form.init();
  if (loadErrors && loadErrors.length) throw new Error("enketo load errors: " + JSON.stringify(loadErrors));
  form.calc.update();
  form.output.update();
  form.editStatus = false;
  return form;
}

const nodeVal = (form, name) => {
  const n = form.model.xml.querySelector(`${ROOT.slice(1)} > ${name}`);
  return n ? n.textContent : null;
};

// ------------------------------------------------------------------ interactive page
let current = null;
const $wrap = () => $("#form-wrap");

function setupNavButtons(index) {
  const lastIndex = current.pages.activePages.length - 1;
  const footer = $wrap().find(".form-footer");
  footer.removeClass("end");
  footer.find(".previous-page, .next-page").removeClass("disabled");
  if (index >= lastIndex) {
    footer.addClass("end");
    footer.find(".next-page").addClass("disabled");
  }
  if (index <= 0) footer.find(".previous-page").addClass("disabled");
  $("#page-indicator").text(`Page ${index + 1} of ${lastIndex + 1}`);
}

function forceRecalculate(form) {
  form.calc.update();
  form.output.update();
}

async function nextPage() {
  const valid = await current.pages._next();
  if (valid) setupNavButtons(current.pages._getCurrentIndex());
  forceRecalculate(current);
  refreshPanel();
  return valid;
}

/** Back to the first page (Previous pressed until page 1), e.g. to re-walk the form after an edit. */
function firstPage() {
  for (let guard = 0; guard < 100 && current.pages._getCurrentIndex() > 0; guard++) prevPage();
  return current.pages._getCurrentIndex();
}

function prevPage() {
  current.pages._prev();
  setupNavButtons(current.pages._getCurrentIndex());
  forceRecalculate(current);
  refreshPanel();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function prettyXml(xml) {
  const lines = xml.replace(/>\s*</g, ">\n<").split("\n");
  let depth = 0;
  return lines
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(depth) + line;
      if (/^<[^/!?][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join("\n");
}

function refreshPanel() {
  if (!current) return;
  for (const name of WATCH) {
    const v = nodeVal(current, name);
    const el = document.getElementById(`calc-${name}`);
    el.textContent = v === "" ? "(empty)" : v;
    el.dataset.value = v;
  }
  document.getElementById("model-xml").textContent = prettyXml(current.model.getStr());
}

async function submit() {
  const valid = await current.validate();
  const box = document.getElementById("submit-result");
  if (!valid) {
    box.innerHTML = '<p class="submit-error">The form has errors. Fix the highlighted questions.</p>';
    return false;
  }
  // CHT saves getDataStr({ irrelevant: false }): non-relevant (hidden) values are left out.
  const record = current.getDataStr({ irrelevant: false });
  box.innerHTML =
    '<p class="submit-ok">Report would be saved (preview only: nothing is stored or sent).</p><pre>' + escapeHtml(prettyXml(record)) + "</pre>";
  return true;
}

function start() {
  const host = document.querySelector("#form-wrap .container");
  current = createForm(host);
  document.getElementById("submit-result").innerHTML = "";
  setupNavButtons(0);
  refreshPanel();
  const formEl = host.querySelector("form");
  formEl.addEventListener("change", () => setTimeout(refreshPanel, 0));
  formEl.addEventListener("xforms-value-changed", () => setTimeout(refreshPanel, 0));
  current.model.events.addEventListener("dataupdate", () => setTimeout(refreshPanel, 0));
}

$(document).on("click", "#form-wrap .btn.next-page", (e) => {
  e.preventDefault();
  nextPage();
});
$(document).on("click", "#form-wrap .btn.previous-page", (e) => {
  e.preventDefault();
  prevPage();
});
$(document).on("click", "#form-wrap .btn.submit", (e) => {
  e.preventDefault();
  submit();
});
$(document).on("click", "#restart", (e) => {
  e.preventDefault();
  start();
});

// ------------------------------------------------------------------ automation API
/** Visible (relevant, on the current page) question elements, as cht-conf-test-harness sees them. */
function visibleQuestions() {
  const page = current.pages.current ? current.pages.current[0] || current.pages.current : document.querySelector("#form-wrap form");
  return [...page.querySelectorAll(".question")].filter((q) => !q.closest(".disabled") && !q.classList.contains("disabled") && !q.matches(".note, .readonly"));
}

/** Fill one question like cht-conf-test-harness's form-filler (radio click, number val + change). */
function fillQuestion(q, answer) {
  const inputs = [...q.querySelectorAll('input:not([type="hidden"]),textarea,select')];
  const first = inputs[0];
  if (!first) throw new Error("no input in question");
  // An answer that is already there is left alone (as a health worker would): clicking a selected
  // radio again deselects it in enketo, which matters when the form is walked again after an edit.
  if (first.type === "radio") {
    const target = q.querySelector(`input[value="${answer}"]`);
    if (!target) throw new Error(`no option ${answer}`);
    if (!target.checked) target.click();
  } else if ($(first).val() !== String(answer)) {
    $(first).val(String(answer)).trigger("change");
  }
}

const questionName = (q) => q.querySelector("input,select,textarea")?.getAttribute("data-name") || q.querySelector("input,select,textarea")?.getAttribute("name");

function labelText(q) {
  const el = q.querySelector(".question-label.active");
  if (!el) return "";
  const c = el.cloneNode(true);
  c.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return c.textContent.trim();
}

function visibleNotes() {
  return [...document.querySelectorAll("#form-wrap form .question.note, #form-wrap form .question.readonly")]
    .filter((q) => !q.closest(".disabled") && !q.classList.contains("disabled"))
    .map((q) => ({ name: questionName(q), text: labelText(q) }));
}

function visibleErrors() {
  return [...document.querySelectorAll("#form-wrap form .invalid-required, #form-wrap form .invalid-constraint")]
    .filter((q) => !q.closest(".disabled"))
    .map((q) => ({
      name: questionName(q),
      msg: [...q.querySelectorAll(".or-required-msg.active, .or-constraint-msg.active")]
        .filter((s) => getComputedStyle(s).display !== "none")
        .map((s) => s.innerText.trim())
        .join(" "),
    }));
}

function state() {
  const calcs = Object.fromEntries(WATCH.map((n) => [n, nodeVal(current, n)]));
  return {
    page: current.pages._getCurrentIndex(),
    pages: current.pages.activePages.length,
    calcs,
    visibleQuestions: visibleQuestions().map(questionName),
    visibleNotes: visibleNotes(),
    errors: visibleErrors(),
  };
}

/**
 * UI-level fill of the current page: answers is { questionName: value } with values already in
 * form terms ('yes'/'no', integers). Questions are answered in page order, re-reading visibility
 * after each answer (relevance can change). Answers for hidden questions are reported, not typed.
 */
function fillPage(answers) {
  const done = new Set();
  const skipped = [];
  for (let guard = 0; guard < 100; guard++) {
    const next = visibleQuestions().find((q) => !done.has(questionName(q)));
    if (!next) break;
    const name = questionName(next);
    done.add(name);
    const short = name.split("/").pop();
    if (Object.prototype.hasOwnProperty.call(answers, short)) fillQuestion(next, answers[short]);
  }
  for (const k of Object.keys(answers)) if (![...done].some((n) => n.endsWith(`/${k}`))) skipped.push(k);
  refreshPanel();
  return { answered: [...done].map((n) => n.split("/").pop()), notShown: skipped };
}

/** Set one question through the UI wherever it is (used for edit-after-the-fact scenarios). */
function setQuestion(short, value) {
  const q = [...document.querySelectorAll("#form-wrap form .question")].find((x) => (questionName(x) || "").endsWith(`/${short}`));
  if (!q) throw new Error(`question ${short} not found`);
  fillQuestion(q, value);
  refreshPanel();
}

// Model-level batch evaluation for the differential grid. Each point gets a fresh Form (no state
// carried between points), values are set on the model nodes, enketo runs its evaluation cascade
// (calculations, relevance with excludeNonRelevant) and the calculate nodes are read back.
function evaluatePoints(points) {
  let host = document.getElementById("batch-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "batch-host";
    host.style.cssText = "position:absolute;left:-10000px;top:0;width:400px;";
    document.body.appendChild(host);
  }
  const out = [];
  for (const p of points) {
    const form = createForm(host);
    for (const [name, value] of Object.entries(p)) {
      const node = form.model.node(`${ROOT}/q_${name}/${name}`);
      node.setVal(String(value), typeof value === "number" ? "int" : "string");
    }
    form.calc.update();
    const relevantNotes = [...host.querySelectorAll("form .question.note, form .question.readonly")]
      .filter((q) => !q.closest(".disabled") && !q.classList.contains("disabled"))
      .map((q) => questionName(q).split("/").pop());
    // Questions enketo considers relevant (not inside a disabled branch): what a health worker would see.
    const shown = [...host.querySelectorAll("form .question")]
      .filter((q) => !q.closest(".disabled") && !q.classList.contains("disabled") && !q.matches(".note, .readonly"))
      .map((q) => questionName(q))
      .filter((n) => n && !n.startsWith(`${ROOT}/inputs/`))
      .map((n) => n.split("/").pop());
    out.push({ ...Object.fromEntries(WATCH.map((n) => [n, nodeVal(form, n)])), notes: relevantNotes, shown });
  }
  host.innerHTML = "";
  return out;
}

window.previewApi = { start, state, fillPage, setQuestion, nextPage, prevPage, firstPage, submit, evaluatePoints, refreshPanel, ready: false };

document.getElementById("built-from").textContent = DATA.formXmlPath;
try {
  start();
  window.previewApi.ready = true;
} catch (err) {
  document.getElementById("form-wrap").insertAdjacentHTML("afterbegin", `<p class="submit-error">Form failed to load: ${escapeHtml(String(err))}</p>`);
  window.previewApi.error = String(err);
  throw err;
}
