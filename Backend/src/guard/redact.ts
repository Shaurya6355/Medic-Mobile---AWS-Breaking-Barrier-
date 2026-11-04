/** LLM02: scrub secrets and personal data from model output. */
const RULES: ReadonlyArray<[RegExp, string]> = [
  [/\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]*:[^\s"',;)]+/gi, "[redacted-arn]"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, "[redacted-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[redacted]"],
  [/\b(?:api[_-]?key|secret|password|token|passwd)\s*[:=]\s*\S+/gi, "[redacted]"],
  [/\b(?:aws_secret_access_key|secret[_ ]?access[_ ]?key)\b\s*[:=]\s*\S+/gi, "[redacted-key]"],
  [/\b[A-Za-z0-9/+=]{40}\b(?=.*secret)/gi, "[redacted-key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g, "[redacted-phone]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
