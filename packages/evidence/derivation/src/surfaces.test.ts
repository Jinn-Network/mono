// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { sha256Digest } from "./bytes.js";
import { parseDerivationPolicy } from "./policy.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { extractDerivationSurfaces } from "./surfaces.js";
import { validateDerivationSource } from "./source.js";

test("protects structure and emits only policy-admitted metadata literals", () => {
  const input = syntheticDerivationInput();
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(extraction.hold).toBeUndefined();
  expect(extraction.surfaces.some(({ text }) => text.startsWith("sha256:"))).toBe(
    false,
  );
  expect(extraction.surfaces.some(({ text }) => text === "Synthetic task")).toBe(
    true,
  );
  expect(
    extraction.surfaces.some(({ surfaceId }) =>
      surfaceId.startsWith("artifact:trace/trajectory.jsonl"),
    ),
  ).toBe(true);
});

test("fails closed on unclassified extension metadata before detection", () => {
  const input = syntheticDerivationInput();
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"][1].unknownExtension = { nested: "private literal" };
  (input.sourceRecord as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(extraction.hold).toEqual({ code: "unclassified-metadata" });
});

test("throws for malformed declared JSONL", () => {
  const input = syntheticDerivationInput();
  const trace = input.sourceArtifacts.find(
    ({ entityId }) => entityId === "trace/trajectory.jsonl",
  )!;
  (trace as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode("{broken\n");
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"].find(
    (entity: Record<string, unknown>) =>
      entity["@id"] === "trace/trajectory.jsonl",
  ).sha256 = sha256Digest(trace.bytes).slice(7);
  (input.sourceRecord as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
  expect(() =>
    extractDerivationSurfaces(
      validateDerivationSource(input),
      parseDerivationPolicy(input.policyBytes).value,
    ),
  ).toThrowError(
    expect.objectContaining({ code: "STRUCTURED_ARTIFACT_INVALID" }),
  );
});
