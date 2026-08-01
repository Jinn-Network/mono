// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_BLACKHOLE_POLICY } from "./ports.js";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));

describe("ports", () => {
  it("blackholes every direction by default", () => {
    expect(DEFAULT_BLACKHOLE_POLICY).toEqual({
      egress: "denied",
      dns: "absent",
      archiveRpc: "unreachable",
      forkBackend: "absent",
    });
    expect(Object.isFrozen(DEFAULT_BLACKHOLE_POLICY)).toBe(true);
  });

  it("takes no ambient authority anywhere in production source", async () => {
    // Custody law as a test rather than a promise: the tree guard checks the same thing, and
    // a package that fails this fails it here first, in seconds.
    const banned = [
      /\bprocess\s*\.\s*env\b/u,
      /(?<![\w$.])fetch\s*\(/u,
      /["']node:child_process["']/u,
      /["']node:net["']/u,
      /["']node:http["']/u,
      /["']node:dns["']/u,
      /\bDate\s*\.\s*now\s*\(/u,
      /new\s+Date\s*\(\s*\)/u,
    ];
    const names = (await readdir(SOURCE_ROOT))
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".test.ts") && name !== "testing.ts");
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const text = await readFile(`${SOURCE_ROOT}${name}`, "utf8");
      for (const pattern of banned) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false);
      }
    }
  });
});
