// Same construction as the CHT webapp (cht-core webapp/src/js/enketo/OpenrosaXpathEvaluatorBinding.js):
// openrosa-xpath-evaluator 2.0.13's extended-xpath wrapping the browser's native XPathEvaluator, with
// the openrosa extensions. Difference: CHT's medic-xpath-extensions (z-score, to-bikram-sambat,
// difference-in-months, cht:extension-lib, ...) are not added; this form calls none of them.
import ExtendedXpathEvaluator from "extended-xpath";
import openrosaExtensions from "openrosa-extensions";
import { t } from "enketo/translator";

export default function () {
  const ore = openrosaExtensions(t);
  const evaluator = new ExtendedXpathEvaluator(new XPathEvaluator(), ore);
  this.xml.jsEvaluate = evaluator.evaluate;
}
