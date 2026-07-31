// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Words the design forbids this layer from using about its own output. The
// claim is "K consecutive identical outcome-sets under the declared controls";
// anything stronger is over-claiming (design §5.2, program contract 8).
const FORBIDDEN = [
  /\bdeterministic(?:ally)?\b/iu,
  /\bnon-?deterministic\b/iu,
  /\bguarantee[sd]?\b/iu,
  /\bproven\b/iu,
  /\breliable environment\b/iu,
];

/** Every file under `directory`, recursively, as `directory`-relative paths. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`);
}

describe("bounded claims", () => {
  it("no shipped file over-claims", async () => {
    // Source, the scripts that generate and smoke the published artifacts, and the
    // fixture corpus itself -- every file a third party reads. This file is the only
    // exception: it must spell the banned words to ban them.
    const paths = [
      ...await filesUnder(SOURCE_ROOT),
      ...await filesUnder(`${PACKAGE_ROOT}scripts`),
      ...await filesUnder(`${PACKAGE_ROOT}fixtures`),
    ].filter((path) => !path.endsWith("bounded-claims.test.ts"));
    expect(paths.some((path) => path.includes("/scripts/"))).toBe(true);
    expect(paths.some((path) => path.includes("/fixtures/"))).toBe(true);
    for (const path of paths) {
      const text = await readFile(path, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(text), `${path} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("the README states the bound explicitly", async () => {
    const readme = await readFile(`${PACKAGE_ROOT}README.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(readme), `README matches ${String(pattern)}`).toBe(false);
    }
    expect(readme).toContain("K consecutive runs");
    expect(readme).toContain("declared controls");
  });
});
