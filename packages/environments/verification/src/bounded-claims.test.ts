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

describe("bounded claims", () => {
  it("no source file over-claims", async () => {
    // This file is the only exception: it must spell the banned words to ban them.
    const names = (await readdir(SOURCE_ROOT))
      .filter((name) => name.endsWith(".ts") && name !== "bounded-claims.test.ts");
    for (const name of names) {
      const text = await readFile(`${SOURCE_ROOT}${name}`, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false);
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
