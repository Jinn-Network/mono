// SPDX-License-Identifier: MIT

import type {
  BackendCapabilities,
  PreflightReport,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { describe, expect, test, vi } from "vitest";
import {
  validateRequirementsAgainstRunPinning,
  verifyPreclaim,
} from "./preclaim.js";

const PROFILE_URI = "https://jinn.network/task-profiles/repository-work/1.0";

const CAPABILITIES: BackendCapabilities = {
  taskProfiles: [PROFILE_URI],
  inputMediaTypes: [],
  outputMediaTypes: [],
  cancel: false,
  watch: false,
  preflight: true,
  fetchArtifact: false,
  confidentialInputs: false,
  signedObservations: false,
  signedDeliveries: false,
  evidenceCapture: "none",
  deadlineEnforcement: false,
  isolation: ["none"],
  attempts: { maxTotal: [1, 1], maxConcurrent: [1, 1] },
  runPinning: {
    keys: [
      { key: "harness", inventory: ["claude-code", "fixture"], posture: "attested" },
      { key: "model", inventory: ["claude-haiku"], posture: "attested" },
    ],
  },
};

function backendWithPreflight(
  preflight: TaskExecutionBackend["preflight"],
  capabilities: BackendCapabilities = CAPABILITIES,
): TaskExecutionBackend {
  return {
    capabilities: async () => capabilities,
    preflight,
    submit: vi.fn(),
    observe: vi.fn(),
    deliveries: vi.fn(),
    fetchDelivery: vi.fn(),
    recover: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("validateRequirementsAgainstRunPinning", () => {
  test("accepts declared keys within inventory", () => {
    expect(validateRequirementsAgainstRunPinning(
      { harness: "claude-code" },
      CAPABILITIES.runPinning,
    )).toBeUndefined();
  });

  test("rejects undeclared keys", () => {
    expect(validateRequirementsAgainstRunPinning(
      { customFlag: true },
      CAPABILITIES.runPinning,
    )).toBe("customFlag");
  });

  test("rejects values outside inventory", () => {
    expect(validateRequirementsAgainstRunPinning(
      { harness: "codex" },
      CAPABILITIES.runPinning,
    )).toBe("harness");
  });
});

describe("verifyPreclaim", () => {
  test("declines when the profile is not in taskProfiles", async () => {
    const result = await verifyPreclaim(
      { profileUri: "https://example.com/other/1.0", requirements: {} },
      backendWithPreflight(async () => ({ ready: true })),
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, reason: "profile-mismatch" });
  });

  test("declines unsupported requirement keys before preflight", async () => {
    const preflight = vi.fn(async (): Promise<PreflightReport> => ({ ready: true }));
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: { customFlag: true } },
      backendWithPreflight(preflight),
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, reason: "unsupported-requirement", detail: "customFlag" });
    expect(preflight).not.toHaveBeenCalled();
  });

  test("declines when capabilities omit preflight support", async () => {
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: {} },
      backendWithPreflight(async () => ({ ready: true })),
      { ...CAPABILITIES, preflight: false },
    );
    expect(result).toEqual({ ok: false, reason: "preflight-unavailable" });
  });

  test("declines when the backend omits the preflight verb", async () => {
    const backend: TaskExecutionBackend = {
      capabilities: async () => CAPABILITIES,
      submit: vi.fn(),
      observe: vi.fn(),
      deliveries: vi.fn(),
      fetchDelivery: vi.fn(),
      recover: vi.fn(),
      cancel: vi.fn(),
    };
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: {} },
      backend,
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, reason: "preflight-unavailable" });
  });

  test("declines when preflight throws", async () => {
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: {} },
      backendWithPreflight(async () => {
        throw new Error("probe exploded");
      }),
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, reason: "preflight-not-ready", detail: "probe exploded" });
  });

  test("declines when preflight reports not ready", async () => {
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: {} },
      backendWithPreflight(async () => ({ ready: false, detail: "launcher offline" })),
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, reason: "preflight-not-ready", detail: "launcher offline" });
  });

  test("passes when profile, requirements, and preflight are ready", async () => {
    const preflight = vi.fn(async () => ({ ready: true }));
    const result = await verifyPreclaim(
      { profileUri: PROFILE_URI, requirements: { harness: "claude-code" } },
      backendWithPreflight(preflight),
      CAPABILITIES,
    );
    expect(result).toEqual({ ok: true });
    expect(preflight).toHaveBeenCalledWith({
      taskProfile: PROFILE_URI,
      requirements: { harness: "claude-code" },
    });
  });
});
