// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import { describe, expect, test } from "vitest";
import {
  CLAIM_NOTHING,
  evaluateClaimPredicate,
  matchLegacyManifestDigest,
  takeEveryRunnable,
} from "./claim-predicate.js";
import type { SubmissionFacts } from "./types.js";

const BASE_FACTS: SubmissionFacts = {
  taskId: 1n,
  taskDigest: `sha256:${"a".repeat(64)}`,
  submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
  nonce: "nonce-1",
  profileUri: "https://jinn.network/task-profiles/repository-work/1.0",
  requirements: {},
  runnable: true,
  intendedSpendWei: 1n,
  intendedAiUnits: 1,
  workKind: "repo-fix",
};

const CAPABILITIES: BackendCapabilities = {
  taskProfiles: [],
  inputMediaTypes: [],
  outputMediaTypes: [],
  cancel: false,
  watch: false,
  preflight: false,
  fetchArtifact: false,
  confidentialInputs: false,
  signedObservations: false,
  signedDeliveries: false,
  evidenceCapture: "none" as const,
  deadlineEnforcement: false,
  isolation: ["none" as const],
  attempts: { maxTotal: [1, 1], maxConcurrent: [1, 1] },
  runPinning: { keys: [] },
};

const CAPS = { spendCapWei: 10n, aiUnitCap: 5 };

describe("claim predicate", () => {
  test("CLAIM_NOTHING declines every facts card", () => {
    expect(evaluateClaimPredicate(CLAIM_NOTHING, BASE_FACTS, CAPABILITIES, CAPS)).toBe(false);
  });

  test("take-everything-runnable claims runnable work and declines unrunnable work", () => {
    const predicate = takeEveryRunnable();
    expect(evaluateClaimPredicate(predicate, BASE_FACTS, CAPABILITIES, CAPS)).toBe(true);
    expect(evaluateClaimPredicate(
      predicate,
      { ...BASE_FACTS, runnable: false },
      CAPABILITIES,
      CAPS,
    )).toBe(false);
  });

  test("legacy manifest digest matching honors migration wiring entries", () => {
    const predicate = matchLegacyManifestDigest(new Map([
      ["repo-fix", { legacyManifestDigest: "sha256:manifest-a" }],
    ]));
    expect(evaluateClaimPredicate(
      predicate,
      { ...BASE_FACTS, legacyManifestDigest: "sha256:manifest-a" },
      CAPABILITIES,
      CAPS,
    )).toBe(true);
    expect(evaluateClaimPredicate(
      predicate,
      { ...BASE_FACTS, legacyManifestDigest: "sha256:manifest-b" },
      CAPABILITIES,
      CAPS,
    )).toBe(false);
  });
});
