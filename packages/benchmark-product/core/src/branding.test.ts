import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PRODUCT_BRANDING } from "./branding.js";

const BANNED_LEXICON = ["vessel", "vow", "summon", "seer", "smoke", "wane"];

describe("PRODUCT_BRANDING", () => {
  test("publishes the exact Colophon identity from one authority", () => {
    expect(PRODUCT_BRANDING).toEqual({
      displayName: "Colophon",
      categoryDescriptor: "Benchmark publishing for agent configurations",
      tagline: "Compare agents on the same work.",
      promise: "Publish benchmark claims people can check.",
      attribution: "Built on Jinn.",
      commandName: "colophon",
    });
  });

  test("ships the preferred CLI name and the compatibility alias", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly bin?: Readonly<Record<string, string>>;
    };
    expect(packageJson.bin).toEqual({
      colophon: "./dist/cli/bin.js",
      "benchmark-product": "./dist/cli/bin.js",
    });
  });

  test("no Jinn lexicon term appears in any branding value", () => {
    const values = Object.values(PRODUCT_BRANDING);
    for (const term of BANNED_LEXICON) {
      const pattern = new RegExp("\\b" + term, "i");
      for (const value of values) {
        expect(value).not.toMatch(pattern);
      }
    }
  });

  test("ProductBranding is exactly the six approved string fields", () => {
    expect(Object.keys(PRODUCT_BRANDING).sort()).toEqual([
      "attribution",
      "categoryDescriptor",
      "commandName",
      "displayName",
      "promise",
      "tagline",
    ]);
  });
});
