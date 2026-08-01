// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import * as surface from "./index.js";

const SRC = new URL("./", import.meta.url);
// `closed-reproducible` is CE3's word. It may appear in this package only where the code
// reads CE3's outcome -- never as a value this package assigns, and never in a name.
const CE3_OUTCOME_ALLOWED = new Set(["widen.ts", "bounded-claims.test.ts", "testing.ts"]);
const FORBIDDEN = [/\bverified\b/iu, /\bdeterministic\b/iu, /\bauthenticated\b/iu, /\bguarantee/iu];

describe("bounded claims", () => {
  it("names nothing in the public surface 'verified' or 'deterministic'", () => {
    for (const name of Object.keys(surface)) {
      expect(name).not.toMatch(/verified|deterministic|guaranteed/iu);
    }
  });

  it("makes no unqualified claim in production source or the README", async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of files) {
      const text = await readFile(new URL(name, SRC), "utf8");
      for (const pattern of FORBIDDEN) {
        const offending = text.split("\n").filter((line) => pattern.test(line)
          // A line that explicitly bounds the claim is what the design asks for.
          && !/never|not |cannot|does not|is not|forbid|refuse/iu.test(line));
        expect(offending, `${name}: ${offending.join(" | ")}`).toEqual([]);
      }
      if (!CE3_OUTCOME_ALLOWED.has(name)) {
        expect(text, name).not.toContain("closed-reproducible");
      }
    }
  });
});
