import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");
const usage = source.match(/export const USAGE = `([\s\S]*?)`;/)?.[1];

describe("published CLI --help verb list", () => {
  test("USAGE is a source string the wrapper --help path prints", () => {
    expect(usage).toBeDefined();
  });

  test("names every claimant verb and documents launch as the service's", () => {
    expect(usage).toContain("Published claimant verbs:");
    for (const verb of [
      "method",
      "arm add",
      "lock",
      "anchor",
      "run import",
      "collect",
      "report",
      "publish",
      "results",
      "status",
    ]) {
      expect(usage, verb).toContain(verb);
    }
    expect(usage).toContain("launch, resume, preview, quote");
    expect(usage).toContain("service's machinery");
    expect(usage).not.toContain("terminal-bench-2.1");
    expect(usage).toContain("Protocol identifiers in the installed platform packages are names, not addresses.");
  });
});
