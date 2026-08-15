import { describe, expect, test, vi } from "vitest";

import {
  buildTraceDerivationStatement,
  sealTraceDerivationAttestation,
  verifyTraceDerivationAttestation,
} from "./derivation.js";
import { InvalidDocumentError } from "./sealing.js";
import { TRACE_VOCABULARY_PROFILE } from "./identifiers.js";

const baseBuildInput = {
  producerId: "producer-1",
  executionDigest: `sha256:${"b".repeat(64)}` as const,
  traceDigest: `sha256:${"c".repeat(64)}` as const,
  nativeTraceDigest: `sha256:${"a".repeat(64)}` as const,
  formatIri: "https://spec.jinn.network/formats/claude-code-stream-json/v1",
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  vocabularyProfile: TRACE_VOCABULARY_PROFILE,
  timebase: "synthetic-ordinal" as const,
  linkageMode: "forward-linked" as const,
  derivedAt: "2026-07-31T12:00:00Z",
};

describe("derivation port snapshots", () => {
  test("build rejects unknown port keys without invoking getters", () => {
    let getterCalls = 0;
    const input = { ...baseBuildInput };
    Object.defineProperty(input, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => buildTraceDerivationStatement(input)).toThrow(InvalidDocumentError);
    expect(getterCalls).toBe(0);
  });

  test("build rejects proxy port object", () => {
    expect(() =>
      buildTraceDerivationStatement(new Proxy(baseBuildInput, {}) as typeof baseBuildInput),
    ).toThrow(InvalidDocumentError);
  });

  test("seal rejects accessor signer without invoking getter", async () => {
    const statement = buildTraceDerivationStatement(baseBuildInput);
    let getterCalls = 0;
    const input: Record<string, unknown> = { statement };
    Object.defineProperty(input, "signer", {
      get: () => {
        getterCalls += 1;
        return async () => [{ signature: new Uint8Array([1]), keyid: "k" }];
      },
      enumerable: true,
      configurable: true,
    });
    await expect(
      sealTraceDerivationAttestation(input as never),
    ).rejects.toThrow(InvalidDocumentError);
    expect(getterCalls).toBe(0);
  });

  test("verify rejects invalid port with typed invalid-input throw", async () => {
    const verifyAuthority = vi.fn(async () =>
      ({ verified: true as const, signerKeyIds: ["k"] }),
    );
    let getterCalls = 0;
    const input: Record<string, unknown> = {
      envelopeBytes: new Uint8Array([1]),
      executionRecordBytes: new Uint8Array(),
      traceRecordBytes: new Uint8Array(),
      verifyAuthority,
    };
    Object.defineProperty(input, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    await expect(verifyTraceDerivationAttestation(input as never)).rejects.toThrow(
      InvalidDocumentError,
    );
    expect(verifyAuthority).not.toHaveBeenCalled();
    expect(getterCalls).toBe(0);
  });

  test("verify rejects wrong-type envelopeBytes before envelope parse", async () => {
    const verifyAuthority = vi.fn(async () =>
      ({ verified: true as const, signerKeyIds: ["k"] }),
    );
    await expect(
      verifyTraceDerivationAttestation({
        envelopeBytes: "not-bytes" as never,
        executionRecordBytes: new Uint8Array(),
        traceRecordBytes: new Uint8Array(),
        verifyAuthority,
      }),
    ).rejects.toThrow(InvalidDocumentError);
    expect(verifyAuthority).not.toHaveBeenCalled();
  });
});
