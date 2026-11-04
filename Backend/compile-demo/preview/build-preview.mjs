// Builds the static form preview from the cht-conf compiled XForm in compile-demo/output.
//
// Pipeline (mirrors the CHT stack):
//   1. XForm -> enketo HTML + model with xsltproc and cht-core's own XSL stylesheets, exactly as the
//      cht-core api does (api/src/services/generate-xform.js: generateForm / generateModel).
//   2. cht-core's customizeHtml step, ported here: cht:* attributes, markdown in labels and hints
//      (cht-core's own markdown.js is loaded from the checkout), jr:// media src renamed.
//   3. The page app (src/main.js) is bundled with esbuild around enketo-core 7.2.5 with the CHT
//      webapp's enketo config, widget list, XPath binding (minus medic extensions) and the CHT
//      enketo-core patch (/inputs always relevant), applied on load (node_modules is not modified).
//   4. Output: compile-demo/output/preview/{index.html, assets/*, form.html, model.xml, form.xml}.
//      index.html loads only relative classic scripts and styles, so it also works from file://.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FORM_XML, PREVIEW_DIR, PREVIEW_OUT, ensureDeps, findChtCore } from "./paths.mjs";

ensureDeps();
const { parse: parseHtml } = await import("node-html-parser");
const esbuild = await import("esbuild");
const sass = await import("sass");

const MODEL_ROOT_OPEN =
  '<root xmlns="http://www.w3.org/2002/xforms" xmlns:xf="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:ev="http://www.w3.org/2001/xml-events" xmlns:xsd="http://www.w3.org/2001/XMLSchema">';
const ROOT_CLOSE = "</root>";

function xslt(stylesheet, xml) {
  if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml)) throw new Error("Form XML must not declare a DOCTYPE or entities");
  const r = spawnSync("xsltproc", ["--nonet", stylesheet, "-"], { input: xml, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`xsltproc not available: ${r.error.message}`);
  if (r.status !== 0 || r.stderr) throw new Error(`xsltproc failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

// ---- port of cht-core api/src/services/generate-xform.js customizeHtml (same logic) ----
function makeCustomizer(markdown) {
  const replaceNode = (currentNode, newNode) => {
    const { parentNode } = currentNode;
    const idx = parentNode.childNodes.findIndex((child) => child === currentNode);
    parentNode.childNodes = [...parentNode.childNodes.slice(0, idx), newNode, ...parentNode.childNodes.slice(idx + 1)];
  };
  const convertDynamicUrls = (original) =>
    original.replace(
      /<a[^>]+href="([^"]*---output[^"]*)"[^>]*>(.*?)<\/a>/gm,
      '<a href="#" target="_blank" rel="noopener" class="dynamic-url">$2<span class="url hidden">$1</span></a>',
    );
  const convertEmbeddedHtml = (original) =>
    original
      .replace(/&lt;\s*(\/)?\s*([\s\S]*?)\s*&gt;/gm, "<$1$2>")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, "&");
  const getElementChildren = (element) => element?.childNodes?.filter((c) => c.nodeType === 1) || [];
  const getChtAttributeEntries = (el) =>
    Object.entries(el?.attributes || [])
      .filter(([name]) => name.startsWith("cht:"))
      .map(([name, value]) => [`data-cht-${name.substring(4)}`, value]);
  const setQuestionAttributes = (formHtml, questionName, attributes) => {
    const namedElement = formHtml.querySelector(`[name="${questionName}"]`);
    const questionElement = namedElement?.closest(".question") || namedElement;
    attributes.forEach(([name, value]) => questionElement?.setAttribute(name, value));
  };
  const populateChtAttributeData = (formHtml, el, currentPath = "") => {
    const currentName = `${currentPath}/${el?.localName}`;
    const attributes = getChtAttributeEntries(el);
    if (attributes.length) setQuestionAttributes(formHtml, currentName, attributes);
    getElementChildren(el).forEach((c) => populateChtAttributeData(formHtml, c, currentName));
  };
  const setChtAttributes = (formXml, formElement) => {
    const instanceElement = parseHtml(formXml).querySelector("instance");
    populateChtAttributeData(formElement, getElementChildren(instanceElement)[0]);
  };
  const replaceAllMarkdown = (form) => {
    const replacements = {};
    form.querySelectorAll("span.or-output").forEach((el, index) => {
      const key = `---output-${index}`;
      const textNode = el.childNodes[0];
      replacements[key] = el.toString();
      textNode.textContent = key;
      replaceNode(el, textNode);
    });
    const questions = form.querySelectorAll("span.question-label");
    const hints = form.querySelectorAll("span.or-hint");
    questions.concat(hints).forEach((el, index) => {
      const original = el.innerHTML;
      let rendered = markdown.toHtml(original);
      rendered = convertDynamicUrls(rendered);
      rendered = convertEmbeddedHtml(rendered);
      if (original !== rendered) {
        const key = `$$$${index}`;
        replacements[key] = rendered;
        el.innerHTML = key;
      }
    });
    let result = form.toString();
    Object.keys(replacements)
      .reverse()
      .forEach((key) => {
        const replacement = replacements[key];
        if (replacement) result = result.replace(key, replacement);
      });
    return result;
  };
  return (formXml, formString) => {
    const formElement = parseHtml(formString).querySelector("form");
    setChtAttributes(formXml, formElement);
    return replaceAllMarkdown(formElement).replace(/ src="jr:\/\//gi, ' data-media-src="');
  };
}

// ---- esbuild plugin: CHT's enketo-core 7.2.5 patch (webapp/patches/enketo-core+7.2.5.patch) ----
const CHT_PATCHES = {
  "enketo-core/src/js/form.js": [
    [
      "            const path = that.input.getName(node);\n            let target;\n",
      "            const path = that.input.getName(node);\n            let target;\n\n            // CHT-CORE PATCH\n            // /inputs is ALWAYS relevant #4875\n            if(/\\/inputs$/.test(path)) return;\n",
    ],
  ],
  "enketo-core/src/js/relevant.js": [
    [
      "            if (\n                this.process(branchNode, path, result, forceClearNonRelevant, {",
      "            // CHT-CORE PATCH\n            // /inputs is ALWAYS relevant #4875\n            if(!result && /^\\/[^/]+\\/inputs$/.test(path)) {\n                this.enable(branchNode, path, options);\n                branchChange = true;\n                branchNode.classList.add('disabled');\n            }\n            else if (\n                this.process(branchNode, path, result, forceClearNonRelevant, {",
    ],
  ],
};
const chtPatchPlugin = {
  name: "cht-enketo-patch",
  setup(build) {
    build.onLoad({ filter: /enketo-core[\\/]src[\\/]js[\\/](form|relevant)\.js$/ }, (args) => {
      const key = Object.keys(CHT_PATCHES).find((k) => args.path.replace(/\\/g, "/").endsWith(k));
      let src = readFileSync(args.path, "utf8");
      for (const [from, to] of CHT_PATCHES[key]) {
        if (!src.includes(from)) throw new Error(`CHT patch anchor not found in ${key}; enketo-core version changed?`);
        src = src.replace(from, to);
      }
      return { contents: src, loader: "js" };
    });
  },
};

export async function buildPreview({ quiet = false, formXmlPath = FORM_XML } = {}) {
  const log = quiet ? () => {} : console.log;
  const chtCore = findChtCore();
  const formXml = readFileSync(formXmlPath, "utf8");
  const markdown = createRequire(import.meta.url)(join(chtCore, "api/src/enketo-transformer/markdown.js"));
  const formRaw = xslt(join(chtCore, "api/src/xsl/openrosa2html5form.xsl"), formXml);
  const formHtml = makeCustomizer(markdown)(formXml, formRaw);
  let model = xslt(join(chtCore, "api/src/enketo-transformer/xsl/openrosa2xmlmodel.xsl"), formXml);
  model = model.replace(MODEL_ROOT_OPEN, "");
  const idx = model.lastIndexOf(ROOT_CLOSE);
  if (idx !== -1) model = model.slice(0, idx) + model.slice(idx + ROOT_CLOSE.length);
  if (!formHtml.includes('class="or clearfix pages"')) {
    log("WARNING: the form has no class=\"pages\": enketo and CHT show it as one long page");
  }

  rmSync(PREVIEW_OUT, { recursive: true, force: true });
  mkdirSync(join(PREVIEW_OUT, "assets"), { recursive: true });
  writeFileSync(join(PREVIEW_OUT, "form.html"), formHtml);
  writeFileSync(join(PREVIEW_OUT, "model.xml"), model);
  copyFileSync(formXmlPath, join(PREVIEW_OUT, "form.xml"));
  // Data file as a classic script so index.html works from file:// (fetch of local files is blocked there).
  const data = { formHtml, model, formXmlPath: formXmlPath === FORM_XML ? "compile-demo/output/project/forms/app/cough_fast_breathing.xml" : `MUTATED COPY for the verify self-check: ${formXmlPath}`, builtFrom: chtCore.replace(/.*\/repos\//, "repos/") };
  writeFileSync(join(PREVIEW_OUT, "assets", "form-data.js"), `window.__PREVIEW_FORM__ = ${JSON.stringify(data)};\n`);

  const nm = join(PREVIEW_DIR, "node_modules");
  await esbuild.build({
    entryPoints: [join(PREVIEW_DIR, "src", "main.js")],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: join(PREVIEW_OUT, "assets", "preview.js"),
    logLevel: "warning",
    legalComments: "none",
    minify: true,
    alias: {
      "enketo/config": join(PREVIEW_DIR, "src", "enketo-config.js"),
      "enketo/widgets": join(PREVIEW_DIR, "src", "widgets.js"),
      "enketo/xpath-evaluator-binding": join(PREVIEW_DIR, "src", "xpath-binding.js"),
      "enketo/translator": join(nm, "enketo-core/src/js/fake-translator.js"),
      "enketo/dialog": join(nm, "enketo-core/src/js/fake-dialog.js"),
      "enketo/file-manager": join(nm, "enketo-core/src/js/file-manager.js"),
      "extended-xpath": join(nm, "openrosa-xpath-evaluator/src/extended-xpath.js"),
      "openrosa-extensions": join(nm, "openrosa-xpath-evaluator/src/openrosa-extensions.js"),
      // CHT excludes node-forge too (breaks only the digest() XPath function, unused here).
      "node-forge": join(PREVIEW_DIR, "src", "empty.js"),
    },
    plugins: [chtPatchPlugin],
  });

  const css = sass.compile(join(PREVIEW_DIR, "src", "preview.scss"), {
    loadPaths: [nm],
    style: "compressed",
    quietDeps: true,
    silenceDeprecations: ["import", "global-builtin", "color-functions", "slash-div", "mixed-decls"],
    logger: sass.Logger.silent,
  }).css;
  writeFileSync(join(PREVIEW_OUT, "assets", "preview.css"), css);
  writeFileSync(join(PREVIEW_OUT, "index.html"), readFileSync(join(PREVIEW_DIR, "src", "index.html"), "utf8"));
  log(`preview built: ${PREVIEW_OUT}/index.html (XSL from ${chtCore})`);
  return PREVIEW_OUT;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPreview();
}
