import { describe, expect, test } from "vitest";
import { PRODUCT_BRANDING } from "./branding.js";

const BANNED_LEXICON = ["vessel", "vow", "summon", "seer", "smoke", "wane"];

describe("PRODUCT_BRANDING", () => {
  test("displayName is machine-checkably a placeholder", () => {
    expect(PRODUCT_BRANDING.displayName.toLowerCase()).toContain("placeholder");
  });

  test("attribution states independent verifiability", () => {
    expect(PRODUCT_BRANDING.attribution).toContain("independently verifiable");
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

  test("ProductBranding is exactly the three string fields", () => {
    expect(Object.keys(PRODUCT_BRANDING).sort()).toEqual(["attribution", "displayName", "tagline"]);
  });
});
