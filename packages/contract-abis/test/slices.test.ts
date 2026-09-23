import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickAbiItems, type AbiItem } from "../src/pick.js";

const generatedRoot = join(import.meta.dirname, "..", "generated");

function loadFull(contract: string): readonly AbiItem[] {
  return JSON.parse(readFileSync(join(generatedRoot, "full", `${contract}.json`), "utf8"));
}

function loadSlice(key: string): { export: string; items: readonly AbiItem[] } {
  return JSON.parse(readFileSync(join(generatedRoot, "slices", `${key}.json`), "utf8"));
}

describe("generated contract ABIs", () => {
  it("includes all manifest contracts", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "contracts.manifest.json"), "utf8"));
    for (const key of Object.keys(manifest.contracts)) {
      expect(() => loadFull(key)).not.toThrow();
    }
  });

  it("matches every slice to its source contract", () => {
    const slicesManifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "slices.manifest.json"), "utf8"));
    for (const [sliceKey, slice] of Object.entries(slicesManifest.slices)) {
      const full = loadFull(slice.contract);
      const generated = loadSlice(sliceKey);
      expect(generated.export).toBe(slice.export);
      expect([...generated.items]).toEqual([...pickAbiItems(full, slice.items)]);
    }
  });
});
