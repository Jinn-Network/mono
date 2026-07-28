import { describe, expect, test } from "vitest";
import { MARKETPLACE_CORE_KEY_CLASSES, marketplaceCapabilities } from "./capabilities.js";

describe("marketplaceCapabilities", () => {
  test("every declared run-pinning key carries the attested posture (profiles §5.2 -- an open-competition binding cannot enforce)", async () => {
    const capabilities = await marketplaceCapabilities();
    expect(capabilities.runPinning.keys.length).toBeGreaterThan(0);
    for (const entry of capabilities.runPinning.keys) {
      expect(entry.posture).toBe("attested");
    }
  });

  test("today-mode bound: maxConcurrent's ceiling equals maxTotal's ceiling (no separate on-chain concurrency parameter, §6.1/§7)", async () => {
    const capabilities = await marketplaceCapabilities();
    expect(capabilities.attempts.maxConcurrent).toEqual(capabilities.attempts.maxTotal);
  });

  test("declares no optional verb this milestone has not wired (cancel/preflight/watch/fetchArtifact all false at M2 scope)", async () => {
    const capabilities = await marketplaceCapabilities();
    expect(capabilities.cancel).toBe(false);
    expect(capabilities.preflight).toBe(false);
    expect(capabilities.watch).toBe(false);
    expect(capabilities.fetchArtifact).toBe(false);
  });

  test("declares signed, evidence-captured Deliveries (the §16.2 marketplace profile mandates both)", async () => {
    const capabilities = await marketplaceCapabilities();
    expect(capabilities.signedDeliveries).toBe(true);
    expect(capabilities.evidenceCapture).toBe("always");
  });
});

describe("MARKETPLACE_CORE_KEY_CLASSES", () => {
  test("declares a comparison class for every attested run-pinning key", async () => {
    const capabilities = await marketplaceCapabilities();
    for (const entry of capabilities.runPinning.keys) {
      expect(MARKETPLACE_CORE_KEY_CLASSES[entry.key]).toBeDefined();
    }
  });
});
