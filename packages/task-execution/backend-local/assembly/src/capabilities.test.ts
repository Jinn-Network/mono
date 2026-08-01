import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import { describe, expect, test } from "vitest";
import { assembleCapabilities } from "./capabilities.js";

function launcher(
  id: string,
  taskProfiles: string[],
  keys: Array<{ key: string; inventory: string[] }> = [],
  secretForwards: Array<{ grantKey: string; target: string }> = [],
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
      secretForwards,
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
      posture: "attested",
    });
    expect(capabilities.runPinning.keys).toContainEqual({
      key: "model",
      inventory: ["model-a"],
      posture: "attested",
    });
  });

  test("advertises enforced only when every launcher contributing a pin key has a configured deployment", () => {
    const input = {
      launchers: [
        launcher("configured", ["profile:one"], [{ key: "harness", inventory: ["configured"] }]),
        launcher("unconfigured", ["profile:one"], [{ key: "harness", inventory: ["unconfigured"] }]),
      ],
      provisioner: {
        taskProfiles: ["profile:one"], workspaceKinds: ["dir" as const], inputMediaTypes: [], outputMediaTypes: [], isolation: ["process"],
      },
      recorderAvailability: "none" as const,
      trustKeys: {},
    };

    expect(assembleCapabilities({ ...input, enforcedLauncherIds: new Set(["configured"]) }))
      .toMatchObject({ runPinning: { keys: [{ key: "harness", inventory: ["configured", "unconfigured"], posture: "attested" }] } });
    expect(assembleCapabilities({ ...input, enforcedLauncherIds: new Set(["configured", "unconfigured"]) }))
      .toMatchObject({ runPinning: { keys: [{ key: "harness", inventory: ["configured", "unconfigured"], posture: "enforced" }] } });
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
      },
    });
    expect(capabilities.signedObservations).toBe(true);
    // No `deliverySigningKey` supplied -- finding E31: absence, not a hardcoded flag, is what
    // reports `false` here.
    expect(capabilities.signedDeliveries).toBe(false);
  });

  test("advertises signedDeliveries only when a real delivery-signing key is present (finding E31)", () => {
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
        deliverySigningKey: { keyId: "test-key", sign: (payload) => payload },
      },
    });
    expect(capabilities.signedDeliveries).toBe(true);
  });

  test("withdraws cancellation and active deadlines when Linux custody is unavailable", () => {
    const capabilities = assembleCapabilities({
      launchers: [launcher("fixture", ["profile:one"])],
      provisioner: {
        taskProfiles: ["profile:one"], workspaceKinds: ["dir"], inputMediaTypes: [], outputMediaTypes: [], isolation: ["process"],
      },
      recorderAvailability: "none",
      trustKeys: {},
      custody: { ready: false },
    });
    expect(capabilities.cancel).toBe(false);
    expect(capabilities.deadlineEnforcement).toBe(false);
  });

  test("excludes secret-requiring launchers without hiding a non-secret peer", () => {
    const input = {
      launchers: [
        launcher("secret", ["profile:shared", "profile:secret"], [
          { key: "harness", inventory: ["secret"] },
        ], [{ grantKey: "key", target: "key" }]),
        launcher("plain", ["profile:shared"], [
          { key: "harness", inventory: ["plain"] },
        ]),
      ],
      provisioner: {
        taskProfiles: ["profile:shared", "profile:secret"],
        workspaceKinds: ["dir" as const], inputMediaTypes: [], outputMediaTypes: [], isolation: ["process"],
      },
      recorderAvailability: "none" as const,
      trustKeys: {},
    };

    expect(assembleCapabilities({ ...input, secretForwardResolverConfigured: false })).toMatchObject({
      taskProfiles: ["profile:shared"],
      runPinning: { keys: [{ key: "harness", inventory: ["plain"], posture: "attested" }] },
    });
    expect(assembleCapabilities({ ...input, secretForwardResolverConfigured: true })).toMatchObject({
      taskProfiles: ["profile:secret", "profile:shared"],
      runPinning: { keys: [{ key: "harness", inventory: ["plain", "secret"], posture: "attested" }] },
    });
  });
});
