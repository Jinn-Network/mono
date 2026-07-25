// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "./prepare.js";
import { parsePreparedAttestation } from "./prepared.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function malleatePaddingBits(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding === 0) throw new Error("Fixture base64 must contain padding.");
  const index = value.length - padding - 1;
  const original = alphabet.indexOf(value[index]!);
  const significantMask = padding === 2 ? 0x30 : 0x3c;
  const replacement = [...alphabet].findIndex(
    (_character, candidate) =>
      candidate !== original &&
      (candidate & significantMask) === (original & significantMask),
  );
  if (replacement < 0) throw new Error("Could not malleate base64 fixture.");
  return `${value.slice(0, index)}${alphabet[replacement]}${value.slice(index + 1)}`;
}

describe("prepared attestation parsing", () => {
  test("round-trips exact retained bytes defensively", async () => {
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => [{ signature: new Uint8Array([1, 2, 3]) }]);
    const input = Uint8Array.from(prepared.envelopeBytes);
    const parsed = parsePreparedAttestation(input);
    expect(parsed).toEqual(prepared);
    input[0] = 0;
    parsed.envelopeBytes[0] = 0;
    expect(parsePreparedAttestation(prepared.envelopeBytes)).toEqual(prepared);
  });

  test("rejects malformed and unknown families", () => {
    expect(() => parsePreparedAttestation(new Uint8Array([0xff]))).toThrow(
      expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }),
    );
    const statement = Buffer.from(JSON.stringify({
      predicateType: "https://example.test/unknown",
    })).toString("base64");
    const envelope = new TextEncoder().encode(JSON.stringify({
      payloadType: "application/vnd.in-toto+json",
      payload: statement,
      signatures: [{ sig: "AQ==" }],
    }));
    expect(() => parsePreparedAttestation(envelope)).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_ATTESTATION_FAMILY" }),
    );
  });

  test("round-trips Execution Verification", async () => {
    const prepared = await prepareExecutionVerification({
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: { id: "https://example.test/verifier" },
      verifiedAt: "2026-07-24T12:00:00Z",
      verdict: "verified",
    }, async () => [{ signature: new Uint8Array([1]) }]);
    expect(parsePreparedAttestation(prepared.envelopeBytes)).toEqual(prepared);
  });

  test.each([
    new TextEncoder().encode("{"),
    new TextEncoder().encode(JSON.stringify({ payload: "***", signatures: [] })),
  ])("rejects malformed retained bytes %#", (bytes) => {
    expect(() => parsePreparedAttestation(bytes)).toThrow(
      expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }),
    );
  });

  test("rejects missing signatures, tampering, and subject-binding failures", async () => {
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => [{ signature: new Uint8Array([1]) }]);
    const envelope = JSON.parse(new TextDecoder().decode(prepared.envelopeBytes));
    expect(() => parsePreparedAttestation(new TextEncoder().encode(JSON.stringify({
      ...envelope,
      signatures: [],
    })))).toThrow(expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }));
    const tampered = Uint8Array.from(prepared.envelopeBytes);
    const payloadOffset = new TextDecoder().decode(tampered).indexOf(envelope.payload);
    tampered[payloadOffset + 2] = tampered[payloadOffset + 2] === 65 ? 66 : 65;
    expect(() => parsePreparedAttestation(tampered)).toThrow(
      expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }),
    );
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.predicate.resultSubjects = ["missing"];
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    expect(() => parsePreparedAttestation(
      new TextEncoder().encode(JSON.stringify(envelope)),
    )).toThrow(expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }));
  });

  test("rejects noncanonical payload and signature padding bits", async () => {
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => [{ signature: new Uint8Array([1]) }]);
    const original = JSON.parse(
      new TextDecoder().decode(prepared.envelopeBytes),
    );
    for (const envelope of [
      {
        ...original,
        payload: malleatePaddingBits(original.payload),
      },
      {
        ...original,
        signatures: [{
          ...original.signatures[0],
          sig: malleatePaddingBits(original.signatures[0].sig),
        }],
      },
    ]) {
      expect(
        Buffer.from(envelope.payload, "base64").equals(
          Buffer.from(original.payload, "base64"),
        ),
      ).toBe(true);
      expect(() =>
        parsePreparedAttestation(
          new TextEncoder().encode(JSON.stringify(envelope)),
        )
      ).toThrow(
        expect.objectContaining({ code: "PREPARED_ATTESTATION_INVALID" }),
      );
    }
  });
});
