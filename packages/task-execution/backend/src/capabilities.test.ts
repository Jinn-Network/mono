import { describe, expect, test } from "vitest";
import { RUN_PINNING_ENFORCEMENT_POSTURES } from "./capabilities.js";
import type { BackendCapabilities, RunPinningKeySupport } from "./capabilities.js";

describe("BackendCapabilities", () => {
  test("declares exactly the two run-pinning enforcement postures (profiles §5.2)", () => {
    expect(RUN_PINNING_ENFORCEMENT_POSTURES).toEqual(["enforced", "attested"]);
  });

  test("a representative capability record type-checks", () => {
    const harnessSupport: RunPinningKeySupport = {
      key: "harness",
      inventory: ["claude-code", "codex"],
      posture: "enforced",
    };
    const modelSupport: RunPinningKeySupport = {
      key: "model",
      inventory: ["anthropic"],
      posture: "attested",
    };

    const capabilities: BackendCapabilities = {
      taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["application/json"],
      maxArtifactBytes: 10_000_000,
      cancel: true,
      watch: false,
      preflight: true,
      fetchArtifact: false,
      confidentialInputs: false,
      signedObservations: false,
      signedDeliveries: false,
      evidenceCapture: "available",
      deadlineEnforcement: true,
      isolation: ["process"],
      attempts: { maxTotal: [1, 3], maxConcurrent: [1, 1] },
      runPinning: { keys: [harnessSupport, modelSupport] },
    };

    expect(capabilities.runPinning.keys).toHaveLength(2);
    expect(capabilities.runPinning.keys[0]?.posture).toBe("enforced");
    expect(capabilities.runPinning.keys[1]?.posture).toBe("attested");
  });
});
