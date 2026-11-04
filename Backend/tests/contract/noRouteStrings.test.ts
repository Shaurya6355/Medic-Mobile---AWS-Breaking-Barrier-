import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..", "..", "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("route strings live only in src/contract", () => {
  it("finds no string literal starting with /runs outside contract/", () => {
    const offenders = tsFiles(srcDir)
      .filter((f) => !relative(srcDir, f).startsWith("contract" + sep))
      .filter((f) => /["'`]\/runs/.test(readFileSync(f, "utf8")))
      .map((f) => relative(srcDir, f));
    expect(offenders).toEqual([]);
  });
});
