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

test("throws STRUCTURED_ARTIFACT_INVALID without output", async () => {
  const input = syntheticDerivationInput();
  const trace = input.sourceArtifacts.find(
    ({ entityId }) => entityId === "trace/trajectory.jsonl",
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
