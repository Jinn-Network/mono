import { describe, expect, test } from "vitest";

import {
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadInvalidJson,
  readAdversarialJson,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

describe("fixtures", () => {
  test.each(["valid", "minimal"] as const)("golden %s parses and re-seals to its pin", async (name) => {
    const bytes = await loadGoldenBytes(name);
    const digest = await loadGoldenDigest(name);
    expect(documentDigest(bytes)).toBe(digest);
    expect(parseTrajectory(bytes).protocol).toBeDefined();
    expect(sealTrajectory(await loadGoldenJson(name)).digest).toBe(digest);
  });

  test.each([
    "forged-span-id",
    "forged-trace-id",
    "unsorted-attributes",
    "unknown-extension-key",
  ] as const)("invalid fixture %s is rejected", async (name) => {
    expect(TrajectoryRecordSchema.safeParse(await loadInvalidJson(name)).success).toBe(false);
  });

  test("key-permuted equivalence twins seal to one pinned digest", async () => {
    const expected = await loadEquivalenceExpectedDigest();
    expect(sealTrajectory(await loadEquivalenceInput("a")).digest).toBe(expected);
    expect(sealTrajectory(await loadEquivalenceInput("b")).digest).toBe(expected);
  });

  test("every adversarial case is present and behaves as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(4);
    for (const entry of manifest.fixtures) {
      const document = await readAdversarialJson(entry.id, "document.json");
      const result = TrajectoryRecordSchema.safeParse(document);
      expect(result.success).toBe(entry.expectedDisposition === "accepted");
    }
  });
});
