import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIMANT_COMMAND_PATH, renderClaimantCommandPath } from "@colophon-claims/core";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "main.ts"), "utf8");
const usage = source.match(/export const USAGE = `([\s\S]*?)`;/)?.[1];
const readme = readFileSync(join(here, "..", "README.md"), "utf8");

/** Asserts every needle is present in `text` and that they appear in the order given. */
function expectInOrder(text: string, needles: readonly string[]): void {
  const found = needles.map((needle) => text.indexOf(needle));
  for (const [index, at] of found.entries()) expect(at, needles[index]).toBeGreaterThanOrEqual(0);
  expect(found).toEqual([...found].sort((left, right) => left - right));
}

describe("published CLI --help verb list", () => {
  test("USAGE is a source string the wrapper --help path prints", () => {
    expect(usage).toBeDefined();
  });

  // Issue #4943: the list started at `method`, which cannot run before `init` and `draft create`.
  // The order is core's exported claimant path, so this help cannot drift from `method --help`.
  test("lists the claimant path in the order a brought run needs", () => {
    expect(usage).toContain("Published claimant verbs, in the order a brought run needs:");
    expect(usage).toContain(`\n  ${renderClaimantCommandPath()}\n`);
    expectInOrder(usage!, CLAIMANT_COMMAND_PATH.map((step) => `  colophon ${step.verb} --help\n`));
    expect(usage).toContain("init creates the workspace");
    expect(usage).toContain("draft create creates the draft");
  });

  test("names the read verbs", () => {
    for (const verb of ["inspect", "status", "results"]) {
      expect(usage, verb).toContain(`  colophon ${verb} --help\n`);
    }
  });

  // Issue #4944: `lock` accepts only a quoted draft, so quote is a claimant step and not the
  // service's machinery.
  test("says quote is required before lock today and documents launch as the service's", () => {
    expect(usage).toContain("quote is required before lock today");
    expect(usage).toContain("launch, resume, preview, and the other venue-orchestration verbs");
    expect(usage).toContain("service's machinery");
    expect(usage).not.toContain("launch, resume, preview, quote");
    expect(usage).not.toContain("terminal-bench-2.1");
    expect(usage).toContain("Protocol identifiers in the installed platform packages are names, not addresses.");
  });
});

describe("published CLI README verb table", () => {
  test("lists the claimant path in the same order as the help", () => {
    const section = readme.slice(readme.indexOf("| Verb | Role |"), readme.indexOf("`help --advanced`"));
    expectInOrder(section, CLAIMANT_COMMAND_PATH.map((step) => `| \`${step.verb}\` |`));
    expectInOrder(section, CLAIMANT_COMMAND_PATH.map((step) => ` ${step.verb} --help\n`));
  });

  test("agrees with the help that quote comes before lock", () => {
    expect(readme).not.toMatch(/`launch`, `resume`, `preview`, `quote`/u);
    expect(readme).toMatch(/`quote`[^\n]*required before `lock` today/u);
  });
});
