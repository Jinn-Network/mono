/**
 * Extends the branding lexicon sweep (`../branding.test.ts`) to every product
 * source file, CLI strings included (spec §9: branding isolation). The Jinn
 * lexicon (see CLAUDE.md §Design System) is protocol-level vow-language and
 * must never leak into this product's own surfaces.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PRODUCT_BRANDING } from "../branding.js";
import { USAGE } from "./main.js";

const BANNED_LEXICON = ["vessel", "vow", "summon", "seer", "smoke", "wane"];

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("product lexicon sweep", () => {
  test("no banned Jinn lexicon term appears in any product source file", () => {
    const files = collectTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const term of BANNED_LEXICON) {
        const pattern = new RegExp(`\\b${term}`, "i");
        expect(text, `${file} contains banned lexicon term "${term}"`).not.toMatch(pattern);
      }
    }
  });
});

describe("CLI branding isolation (spec §9)", () => {
  test("USAGE carries the product display name and never the word Jinn", () => {
    expect(USAGE).toContain(PRODUCT_BRANDING.displayName);
    expect(USAGE).not.toMatch(/\bJinn\b/i);
  });

  test("Jinn appears as product identity nowhere in the source; only branding.ts carries the attribution line", () => {
    // Case-sensitive on purpose: the lowercase `@jinn-network/...` package specifier is
    // infrastructure plumbing, not identity; the capitalized word is what a reader sees.
    for (const file of collectTsFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      if (file.endsWith(`${join("src", "branding.ts")}`)) {
        expect(text).toContain("Built on Jinn.");
        continue;
      }
      expect(text, `${file} mentions Jinn outside the branding attribution`).not.toMatch(/Jinn/);
    }
  });
});
