// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { canonicalJsonBytes } from "./bytes.js";
import { syntheticDerivationInput, SYNTHETIC_PRIVATE_VALUES } from "./fixtures.js";
import {
  buildScrubReceipt,
  parseScrubReceipt,
  parseScrubberImplementationDescriptor,
} from "./receipt.js";

const HOSTILE_BYTE_ACCESSORS = [
  { name: "byteLength", key: "byteLength" },
  { name: "length", key: "length" },
  { name: "iterator", key: Symbol.iterator },
] as const;

function validReceiptBytes(): Uint8Array {
  return buildScrubReceipt({
    sourceRecord: {
      family: "execution-evidence",
      digest: `sha256:${"a".repeat(64)}`,
    },
    scrubberAgentId: "https://example.com/scrubber",
    implementationDigest: `sha256:${"b".repeat(64)}`,
    policyDigest: `sha256:${"c".repeat(64)}`,
    detectorDescriptors: [],
    completedAt: "2026-07-26T00:00:00Z",
    mappings: [],
    artifactCounts: { retained: 0, derived: 0, withheld: 0 },
    dispositions: [],
    reproducibility: "byte-stable",
    bindingImpact: {
      executionVerification: "not-transferred-to-derived-record",
      resultEvaluation: "preserved-for-exact-subjects",
      taskDerived: false,
      resultDerived: false,
    },
  }).bytes;
}

const BYTE_PARSERS = [
  {
    name: "scrub receipt",
    bytes: validReceiptBytes,
    parse: (bytes: Uint8Array): unknown => parseScrubReceipt(bytes),
    errorCode: "INVALID_DERIVATION_INPUT",
  },
  {
    name: "scrubber implementation descriptor",
    bytes: (): Uint8Array =>
      syntheticDerivationInput().scrubber.implementationDescriptorBytes,
    parse: (bytes: Uint8Array): unknown =>
      parseScrubberImplementationDescriptor(bytes),
    errorCode: "SCRUBBER_DESCRIPTOR_INVALID",
  },
] as const;

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

test("accepts a public-safe independent implementation descriptor", () => {
  const input = syntheticDerivationInput();
  const value = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  );
  value.name = "@independent/evidence-deriver";
  value.version = "1";
  value.runtime.version = "22.1.0-beta.1";
  value.detectors[0].version = "1";
  expect(
    parseScrubberImplementationDescriptor(canonicalJsonBytes(value)).value
      .name,
  ).toBe("@independent/evidence-deriver");
});

test.each(
  BYTE_PARSERS.flatMap((parser) =>
    HOSTILE_BYTE_ACCESSORS.map((accessor) => ({ parser, accessor })),
  ),
)(
  "$parser.name snapshots valid bytes without executing an own $accessor.name accessor",
  ({ parser, accessor }) => {
    const expected = parser.bytes();
    const bytes = parser.bytes();
    let accessorCalls = 0;
    Object.defineProperty(bytes, accessor.key, {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error("caller byte accessor must not execute");
      },
    });

    parser.parse(bytes);

    expect(accessorCalls).toBe(0);
    expect(expected.byteLength).toBeGreaterThan(0);
  },
);

test.each(BYTE_PARSERS)(
  "$name maps an unsnapshotable byte input to $errorCode",
  ({ bytes, parse, errorCode }) => {
    expect(() => parse(new Proxy(bytes(), {}))).toThrowError(
      expect.objectContaining({ code: errorCode }),
    );
  },
);
