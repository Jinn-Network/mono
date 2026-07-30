import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import type { SubmissionRecord } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { honorOrRejectToday } from "./honor-or-reject.js";

const TODAY_MODE_CAPABILITIES: BackendCapabilities = {
  taskProfiles: [],
  inputMediaTypes: [],
  outputMediaTypes: [],
  cancel: true,
  watch: false,
  preflight: true,
  fetchArtifact: false,
  confidentialInputs: false,
  signedObservations: true,
  signedDeliveries: true,
  evidenceCapture: "available",
  deadlineEnforcement: false,
  isolation: ["none"],
  attempts: { maxTotal: [1, 1000], maxConcurrent: [1, 1000] },
  runPinning: { keys: [] },
};

function baseSubmission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:00000000-0000-5000-8000-000000000000",
    task: { digest: { sha256: "a".repeat(64) } },
    requester: "urn:uuid:00000000-0000-5000-8000-000000000001",
    idempotencyKey: "key-1",
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("honorOrRejectToday", () => {
  test("today-mode finalizes on first verdict: minVerdicts > 1 rejects unsupported-requirement", () => {
    const result = honorOrRejectToday(
      baseSubmission({ evaluationRequirements: { minVerdicts: 2 } }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result).toEqual({
      ok: false,
      category: "unsupported-requirement",
      key: "evaluationRequirements.minVerdicts",
    });
  });

  test("minVerdicts === 1 is honored (today-mode's own finalization rule)", () => {
    const result = honorOrRejectToday(
      baseSubmission({ evaluationRequirements: { minVerdicts: 1 } }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result).toEqual({ ok: true });
  });

  test("unknown evaluation requirements are rejected instead of silently ignored", () => {
    expect(honorOrRejectToday(
      baseSubmission({
        evaluationRequirements: { minConfidenceBps: 900 },
      }),
      {},
      TODAY_MODE_CAPABILITIES,
    )).toEqual({
      ok: false,
      category: "unsupported-requirement",
      key: "evaluationRequirements.minConfidenceBps",
    });
  });

  test("today's chain enforces only maxClaims (=maxTotal): maxConcurrent > maxTotal rejects", () => {
    const result = honorOrRejectToday(
      baseSubmission({ attempts: { maxTotal: 2, maxConcurrent: 3 } }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, category: "unsupported-requirement", key: "attempts.maxConcurrent" });
  });

  test("maxConcurrent <= maxTotal is honored", () => {
    const result = honorOrRejectToday(
      baseSubmission({ attempts: { maxTotal: 3, maxConcurrent: 1 } }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result).toEqual({ ok: true });
  });

  test("closeAt is rejected in today-mode -- no on-chain claim window to enforce it (ruling §7.20)", () => {
    const result = honorOrRejectToday(
      baseSubmission({ closeAt: "2099-06-01T00:00:00Z" }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result).toEqual({ ok: false, category: "unsupported-requirement", key: "closeAt" });
  });

  test("a Submission with none of the three unhonorable shapes is accepted", () => {
    const result = honorOrRejectToday(baseSubmission(), {}, TODAY_MODE_CAPABILITIES);
    expect(result).toEqual({ ok: true });
  });

  test("all three violations at once still reports one deterministic rejection (closeAt checked first)", () => {
    const result = honorOrRejectToday(
      baseSubmission({
        closeAt: "2099-06-01T00:00:00Z",
        evaluationRequirements: { minVerdicts: 2 },
        attempts: { maxTotal: 1, maxConcurrent: 2 },
      }),
      {},
      TODAY_MODE_CAPABILITIES,
    );
    expect(result.ok).toBe(false);
  });
});
