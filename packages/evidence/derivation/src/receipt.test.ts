import { expect, test } from "vitest";

import { canonicalJsonBytes } from "./bytes.js";
import { syntheticDerivationInput, SYNTHETIC_PRIVATE_VALUES } from "./fixtures.js";
import {
  buildScrubReceipt,
  parseScrubReceipt,
  parseScrubberImplementationDescriptor,
} from "./receipt.js";

test("builds stable canonical receipt bytes without private values or circular digest", () => {
  const input = syntheticDerivationInput();
  const implementation = parseScrubberImplementationDescriptor(
    input.scrubber.implementationDescriptorBytes,
  );
  const receipt = buildScrubReceipt({
    sourceRecord: input.sourceRecord.reference,
    scrubberAgentId: input.scrubber.agentId,
    implementationDigest: implementation.digest,
    policyDigest: `sha256:${"a".repeat(64)}`,
    detectorDescriptors: implementation.value.detectors,
    completedAt: input.completedAt,
    mappings: [
      {
        sourceEntityId: "task/task.md",
        sourceDigest: `sha256:${"b".repeat(64)}`,
        derivedEntityId: "derived/b/c",
        derivedDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
    artifactCounts: { retained: 2, derived: 1, withheld: 3 },
    dispositions: [
      { class: "email", disposition: "redact", count: 1 },
    ],
    reproducibility: "byte-stable",
    bindingImpact: {
      executionVerification: "not-transferred-to-derived-record",
      resultEvaluation: "not-transferable-to-derived-subject",
      taskDerived: true,
      resultDerived: false,
    },
  });
  expect(parseScrubReceipt(receipt.bytes).value).toEqual(receipt.value);
  expect(receipt.bytes).toEqual(canonicalJsonBytes(receipt.value));
  const serialized = new TextDecoder().decode(receipt.bytes);
  expect(serialized).not.toContain(SYNTHETIC_PRIVATE_VALUES.knownIdentity);
  expect(serialized).not.toContain(SYNTHETIC_PRIVATE_VALUES.nonce);
  expect(serialized).not.toContain("derivedMetadataDigest");
  expect(serialized).toContain("configurationDigest");
});

test("rejects noncanonical and unknown receipt shapes", () => {
  const value = {
    schemaVersion: "jinn.evidence-derivation.scrub-receipt.v2",
  };
  expect(() => parseScrubReceipt(canonicalJsonBytes(value))).toThrowError(
    expect.objectContaining({ code: "INVALID_DERIVATION_INPUT" }),
  );
});

test("rejects arbitrary implementation descriptor fields", () => {
  const input = syntheticDerivationInput();
  const value = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  );
  value.buildDescription = "/home/private/device";
  expect(() =>
    parseScrubberImplementationDescriptor(canonicalJsonBytes(value)),
  ).toThrowError(
    expect.objectContaining({ code: "SCRUBBER_DESCRIPTOR_INVALID" }),
  );
});
