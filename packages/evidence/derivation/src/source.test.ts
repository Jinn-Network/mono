// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { sha256Digest } from "./bytes.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { validateDerivationSource } from "./source.js";

test("accepts a conforming source and exact artifact bytes", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  expect(source.executionId).toBe(
    "urn:uuid:22222222-2222-4222-8222-222222222222",
  );
  expect(source.artifacts.size).toBe(6);
});

test("rejects a source reference digest mismatch", () => {
  const input = syntheticDerivationInput();
  const changed = structuredClone(input);
  (changed.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    `sha256:${"0".repeat(64)}`;
  expect(() => validateDerivationSource(changed)).toThrowError(
    expect.objectContaining({ code: "SOURCE_DIGEST_MISMATCH" }),
  );
});

test("rejects nonconforming source bytes with diagnostics", () => {
  const input = syntheticDerivationInput();
  const changed = structuredClone(input);
  (changed.sourceRecord as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode("{}");
  (changed.sourceRecord.reference as { digest: `sha256:${string}` }).digest = sha256Digest(
    changed.sourceRecord.bytes,
  );
  expect(() => validateDerivationSource(changed)).toThrowError(
    expect.objectContaining({ code: "SOURCE_NONCONFORMING" }),
  );
});

test("rejects duplicate and mismatched supplied artifacts", () => {
  const duplicate = syntheticDerivationInput();
  (
    duplicate.sourceArtifacts as Array<{
      entityId: string;
      bytes: Uint8Array;
    }>
  ).push(duplicate.sourceArtifacts[0]!);
  expect(() => validateDerivationSource(duplicate)).toThrowError(
    expect.objectContaining({ code: "INVALID_DERIVATION_INPUT" }),
  );

  const mismatch = syntheticDerivationInput();
  mismatch.sourceArtifacts[0]!.bytes[0] ^= 1;
  expect(() => validateDerivationSource(mismatch)).toThrowError(
    expect.objectContaining({ code: "ARTIFACT_DIGEST_MISMATCH" }),
  );
});

test("defensively copies source and artifact bytes", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  input.sourceRecord.bytes.fill(0);
  input.sourceArtifacts[0]!.bytes.fill(0);
  expect(source.recordBytes[0]).not.toBe(0);
  expect(source.artifacts.get("task/task.md")?.[0]).not.toBe(0);
});
