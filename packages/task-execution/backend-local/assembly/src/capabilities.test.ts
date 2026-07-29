import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import { describe, expect, test } from "vitest";
import { assembleCapabilities } from "./capabilities.js";

function launcher(
  id: string,
  taskProfiles: string[],
  keys: Array<{ key: string; inventory: string[] }> = [],
): LauncherContract {
  return {
    id,
    capabilities: () => ({
      taskProfiles,
      inputMediaTypes: ["ignored/by/provisioner"],
      outputMediaTypes: ["ignored/by/provisioner"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      runPinning: {
        keys: keys.map((entry) => ({ ...entry, posture: "enforced" as const })),
      },
    }),
    plan() {
      throw new Error("not used");
    },
  };
}

describe("assembleCapabilities", () => {
  test("intersects launcher profiles with provisioner support and pins local v1 bounds", () => {
    const capabilities = assembleCapabilities({
      launchers: [
        launcher("alpha", ["profile:shared", "profile:launcher-only"], [
          { key: "harness", inventory: ["alpha"] },
          { key: "model", inventory: ["model-a"] },
        ]),
        launcher("beta", ["profile:shared"], [
          { key: "harness", inventory: ["beta"] },
        ]),
      ],
      provisioner: {
        taskProfiles: ["profile:shared", "profile:provisioner-only"],
        workspaceKinds: ["dir"],
        inputMediaTypes: ["application/json"],
        outputMediaTypes: ["text/x-diff"],
        maxArtifactBytes: 1024,
        isolation: ["process"],
      },
      recorderAvailability: "available",
      trustKeys: {},
    });

    expect(capabilities.taskProfiles).toEqual(["profile:shared"]);
    expect(capabilities.inputMediaTypes).toEqual(["application/json"]);
    expect(capabilities.outputMediaTypes).toEqual(["text/x-diff"]);
    expect(capabilities.maxArtifactBytes).toBe(1024);
    expect(capabilities.attempts).toEqual({
      maxTotal: [1, 1],
      maxConcurrent: [1, 1],
    });
    expect(capabilities.runPinning.keys).toContainEqual({
      key: "harness",
      inventory: ["alpha", "beta"],
      posture: "enforced",
    });
    expect(capabilities.runPinning.keys).toContainEqual({
      key: "model",
      inventory: ["model-a"],
      posture: "enforced",
    });
  });

  test.each(["none", "available", "always"] as const)(
    "reflects injected recorder posture %s without probing",
    (recorderAvailability) => {
      const capabilities = assembleCapabilities({
        launchers: [launcher("fixture", ["profile:one"])],
        provisioner: {
          taskProfiles: ["profile:one"],
          workspaceKinds: ["dir"],
          inputMediaTypes: [],
          outputMediaTypes: [],
          isolation: ["process"],
        },
        recorderAvailability,
        trustKeys: {},
      });
      expect(capabilities.evidenceCapture).toBe(recorderAvailability);
      expect(capabilities).toMatchObject({
        cancel: true,
        watch: true,
        preflight: true,
        confidentialInputs: true,
        fetchArtifact: true,
        deadlineEnforcement: true,
      });
    },
  );

  test("derives signing declarations from trust-key configuration", () => {
    const capabilities = assembleCapabilities({
      launchers: [launcher("fixture", ["profile:one"])],
      provisioner: {
        taskProfiles: ["profile:one"],
        workspaceKinds: ["dir"],
        inputMediaTypes: [],
        outputMediaTypes: [],
        isolation: ["process"],
      },
      recorderAvailability: "none",
      trustKeys: {
        observationSigningKeyConfigured: true,
        deliverySigningKeyConfigured: false,
      },
    });
    expect(capabilities.signedObservations).toBe(true);
    expect(capabilities.signedDeliveries).toBe(false);
  });
});
