// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import { createBuiltinDerivationDetectors } from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  baselinePolicyValue,
  syntheticDerivationInput,
  SYNTHETIC_PRIVATE_VALUES,
} from "./fixtures.js";
import type { DerivationDetector } from "./types.js";

const privateConfiguration = {
  schemaVersion: "jinn.private-detector-configuration.v1" as const,
  nonce: "private-test-nonce-0123456789abcdef",
  knownIdentities: [SYNTHETIC_PRIVATE_VALUES.knownIdentity],
  privateAllowlist: [SYNTHETIC_PRIVATE_VALUES.privateAllowlist],
};

function silentDetectors(): readonly DerivationDetector[] {
  return createBuiltinDerivationDetectors({ privateConfiguration }).map(
    (detector) => ({
      descriptor: detector.descriptor,
      async detect() {
        return [];
      },
    }),
  );
}

test("returns exact bytes and claim applicability when publishable unchanged", async () => {
  const input = syntheticDerivationInput();
  const outcome = await createEvidenceDeriver({
    detectors: silentDetectors(),
  }).derive(input);
  expect(outcome.status).toBe("publishable-unchanged");
  if (outcome.status !== "publishable-unchanged") return;
  expect(outcome.record.bytes).toEqual(input.sourceRecord.bytes);
  expect(outcome.record.reference).toEqual(input.sourceRecord.reference);
  expect(outcome.bindingImpact.executionVerification).toBe(
    "existing-verification-applicable",
  );
  expect(outcome.bindingImpact.resultEvaluation).toBe(
    "preserved-for-exact-subjects",
  );
});

test.each([
  "2026-00-01T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-02-29T00:00:00Z",
  "2026-02-31T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "1900-02-29T00:00:00Z",
  "2024-01-01T24:00:00Z",
  "2024-01-01T23:59:59+24:00",
])("rejects calendar-invalid completedAt %s", async (completedAt) => {
  const input = syntheticDerivationInput();
  (input as { completedAt: string }).completedAt = completedAt;
  await expect(
    createEvidenceDeriver({ detectors: silentDetectors() }).derive(input),
  ).rejects.toMatchObject({ code: "INVALID_DERIVATION_INPUT" });
});

test.each([
  "2000-02-29T00:00:00Z",
  "2024-02-29T23:59:59.123456789-05:30",
  "2026-02-28T23:59:59+23:59",
])("accepts calendar-valid completedAt %s", async (completedAt) => {
  const input = syntheticDerivationInput();
  (input as { completedAt: string }).completedAt = completedAt;
  expect(
    await createEvidenceDeriver({ detectors: silentDetectors() }).derive(input),
  ).toMatchObject({ status: "publishable-unchanged" });
});

test("returns a conforming derived record for deterministic redactions", async () => {
  const outcome = await createEvidenceDeriver({
    detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
  }).derive(syntheticDerivationInput());
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  expect(outcome.record.reference.digest).not.toBe(
    syntheticDerivationInput().sourceRecord.reference.digest,
  );
  expect(outcome.artifacts.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining(["policy", "implementation", "receipt"]),
  );
  expect(outcome.bindingImpact.executionVerification).toBe(
    "not-transferred-to-derived-record",
  );
});

test("returns review-required with no publishable fields", async () => {
  const input = syntheticDerivationInput();
  const policy = baselinePolicyValue();
  (policy as { dispositions: typeof policy.dispositions }).dispositions =
    policy.dispositions.map((row) =>
    row.class === "credential" ? { ...row, disposition: "review" as const } : row,
  );
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  const outcome = await createEvidenceDeriver({
    detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
  }).derive(input);
  expect(outcome.status).toBe("review-required");
  expect("record" in outcome).toBe(false);
  expect("artifacts" in outcome).toBe(false);
});

test("withholds protected classes before invoking detectors", async () => {
  const input = syntheticDerivationInput();
  const policy = baselinePolicyValue();
  (
    policy.protectedValueDispositions as Record<string, "retain" | "withhold-record">
  )["agent-iri"] = "withhold-record";
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  let calls = 0;
  const detectors = silentDetectors().map((detector) => ({
    ...detector,
    async detect() {
      calls += 1;
      return [];
    },
  }));
  const outcome = await createEvidenceDeriver({ detectors }).derive(input);
  expect(outcome).toEqual({
    status: "withheld",
    reasons: [
      {
        code: "protected-value-withheld",
        protectedClass: "agent-iri",
      },
    ],
  });
  expect(calls).toBe(0);
});

test("withholds when a required detector is unavailable or fails", async () => {
  const input = syntheticDerivationInput();
  expect(
    await createEvidenceDeriver({ detectors: [] }).derive(input),
  ).toEqual({
    status: "withheld",
    reasons: [{ code: "required-detector-unavailable" }],
  });
  const failing = silentDetectors().map((detector, index) =>
    index === 0
      ? {
          ...detector,
          async detect() {
            throw new Error("offline");
          },
        }
      : detector,
  );
  expect(
    await createEvidenceDeriver({ detectors: failing }).derive(input),
  ).toEqual({
    status: "withheld",
    reasons: [{ code: "required-detector-failed" }],
  });
});

test("rejects an unbound private allowlist commitment before detector effects", async () => {
  const input = syntheticDerivationInput();
  const policy = baselinePolicyValue();
  (
    policy as {
      privateAllowlistConfigurationDigest: `sha256:${string}`;
    }
  ).privateAllowlistConfigurationDigest = `sha256:${"f".repeat(64)}`;
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  let detectorEffects = 0;
  const detectors = createBuiltinDerivationDetectors({
    privateConfiguration,
  }).map((detector) => ({
    descriptor: detector.descriptor,
    async detect(
      surface: Parameters<DerivationDetector["detect"]>[0],
      options: Parameters<DerivationDetector["detect"]>[1],
    ) {
      detectorEffects += 1;
      return detector.detect(surface, options);
    },
  }));
  await expect(
    createEvidenceDeriver({ detectors }).derive(input),
  ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  expect(detectorEffects).toBe(0);
});

test("throws STRUCTURED_ARTIFACT_INVALID without output", async () => {
  const input = syntheticDerivationInput();
  const trace = input.sourceArtifacts.find(
    ({ entityId }) => entityId === "trace/trace.jsonl",
  )!;
  (trace as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode("{invalid\n");
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"].find(
    (candidate: Record<string, unknown>) =>
      candidate["@id"] === trace.entityId,
  ).sha256 = sha256Digest(trace.bytes).slice(7);
  (input.sourceRecord as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
  await expect(
    createEvidenceDeriver({ detectors: silentDetectors() }).derive(input),
  ).rejects.toMatchObject({ code: "STRUCTURED_ARTIFACT_INVALID" });
});

test("throws OPERATION_ABORTED at checkpoints", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    createEvidenceDeriver({ detectors: silentDetectors() }).derive(
      syntheticDerivationInput(),
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
});
