// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/trust-core";
import { expect, vi } from "vitest";

import { caseTest } from "./conformance-case-runner.js";
import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  TrajectoryDerivationCancelledError,
  TrajectoryDerivationSigningError,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import { snapshotByteView } from "./byte-snapshot.js";
import { toBareSha256Hex, toRepositorySha256Digest } from "./digests.js";
import { deriveTraceId } from "./identity.js";
import { TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";

const SOURCE_SHA = "a".repeat(64);
const FORMAT_IRI = "https://jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

function buildStatementFields(
  trajectoryDigest: `sha256:${string}`,
  executionDigest: `sha256:${string}`,
  linkageMode: "forward-linked" | "sealed-parent",
) {
  return {
    producerId: "producer-1",
    executionDigest,
    trajectoryDigest,
    nativeTraceDigest: `sha256:${SOURCE_SHA}` as const,
    formatIri: FORMAT_IRI,
    decoderId: DECODER.decoderId,
    decoderVersion: DECODER.decoderVersion,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    timebase: "synthetic-ordinal" as const,
    linkageMode,
    derivedAt: "2026-07-31T12:00:00Z",
  };
}

/** Registers C1-R47–R51 fifth exact-head reviewer probes on the public conformance kit. */
export function registerFifthReviewProbes(): void {
  caseTest("l2-verified-empty-signer-key-ids-fails", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => ({ verified: true, signerKeyIds: [] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(2);
      expect(result.code).toBe("l2-authority-malformed");
    }
  });

  caseTest("l2-verified-no-envelope-signatures-fails", async () => {
    const noKeySigner: DsseSigner = async () => [{ signature: new Uint8Array([1, 2, 3]) }];
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: noKeySigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(2);
      expect(result.code).toBe("l2-authority-malformed");
    }
  });

  caseTest("l2-verified-duplicate-signer-key-ids-fails", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key", "test-key"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });

  caseTest("l2-verified-mixed-signer-key-ids-fails", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key", "unknown-key"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });

  caseTest("sealed-parent-vacuous-l2-empty-signers-fails", async () => {
    const verifyAuthority = vi.fn(async () => ({ verified: true as const, signerKeyIds: [] as string[] }));
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "sealed-parent"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(2);
      expect(result.code).toBe("l2-authority-malformed");
      expect(result.layers.l3.status).toBe("not-evaluated");
    }
    expect(verifyAuthority).toHaveBeenCalledTimes(1);
  });

  caseTest("signer-output-proxy-array-fails", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const { proxy, revoke } = Proxy.revocable([{ signature: new Uint8Array([1]), keyid: "k" }], {});
    await expect(
      sealTrajectoryDerivationAttestation({
        statement,
        signer: async () => proxy as never,
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationSigningError);
    revoke();
  });

  caseTest("signer-output-signature-getter-fails", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    let getterCalls = 0;
    const hostile = [{ signature: new Uint8Array([1]), keyid: "k" }];
    Object.defineProperty(hostile[0], "signature", {
      get() {
        getterCalls += 1;
        return new Uint8Array([1]);
      },
      enumerable: true,
      configurable: true,
    });
    await expect(
      sealTrajectoryDerivationAttestation({
        statement,
        signer: async () => hostile as never,
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationSigningError);
    expect(getterCalls).toBe(0);
  });

  caseTest("signer-output-valid-unchanged", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    expect(sealed.envelopeBytes.length).toBeGreaterThan(0);
  });

  caseTest("deriveTraceId-revoked-proxy-invalid", () => {
    const { proxy, revoke } = Proxy.revocable(
      {
        sourceDigest: `sha256:${SOURCE_SHA}`,
        formatIri: FORMAT_IRI,
        decoderId: DECODER.decoderId,
        decoderVersion: DECODER.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
      },
      {},
    );
    revoke();
    expect(() => deriveTraceId(proxy as never)).toThrow(InvalidDocumentError);
  });

  caseTest("seal-revoked-statement-invalid", async () => {
    const { proxy, revoke } = Proxy.revocable(
      buildTrajectoryDerivationStatement(
        buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
      ),
      {},
    );
    revoke();
    await expect(
      sealTrajectoryDerivationAttestation({ statement: proxy, signer: fixedSigner }),
    ).rejects.toBeInstanceOf(InvalidDocumentError);
  });

  caseTest("authority-revoked-result-malformed", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const { proxy, revoke } = Proxy.revocable(
      { verified: true, signerKeyIds: ["test-key"] },
      {},
    );
    revoke();
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => proxy as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });

  caseTest("digest-format-hostile-inputs-fail", () => {
    const digest = `sha256:${"a".repeat(64)}` as const;
    for (const hostile of [
      {},
      new String(digest),
      Symbol("x"),
      1n,
      new Proxy({}, {}),
      {
        [Symbol.toPrimitive]() {
          return digest;
        },
      },
    ]) {
      expect(() => toBareSha256Hex(hostile)).toThrow(InvalidDocumentError);
      expect(() => toRepositorySha256Digest(hostile)).toThrow(InvalidDocumentError);
    }
  });

  caseTest("digest-format-valid-canonical-pass", () => {
    const hex = "a".repeat(64);
    expect(toBareSha256Hex(`sha256:${hex}`)).toBe(hex);
    expect(toRepositorySha256Digest(hex)).toBe(`sha256:${hex}`);
  });

  caseTest("byte-snapshot-shadowed-slice-zero", () => {
    let sliceCalls = 0;
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, "slice", {
      get() {
        sliceCalls += 1;
        return () => new Uint8Array([9]);
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => snapshotByteView(bytes, "view")).toThrow(TypeError);
    expect(sliceCalls).toBe(0);
  });

  caseTest("byte-snapshot-hostile-views-fail", () => {
    class SubUint8Array extends Uint8Array {}
    expect(() => snapshotByteView(new SubUint8Array([1]), "view")).toThrow(TypeError);
    const augmented = new Uint8Array([1]);
    Object.defineProperty(augmented, "forged", {
      value: 1,
      enumerable: true,
      configurable: true,
    });
    expect(() => snapshotByteView(augmented, "view")).toThrow(TypeError);
    const { proxy, revoke } = Proxy.revocable(new Uint8Array([1]), {});
    expect(() => snapshotByteView(proxy, "view")).toThrow(TypeError);
    revoke();
    expect(() => snapshotByteView(proxy, "view")).toThrow(TypeError);
    if (typeof SharedArrayBuffer !== "undefined") {
      const sab = new SharedArrayBuffer(4);
      expect(() => snapshotByteView(new Uint8Array(sab), "view")).toThrow(TypeError);
    }
  });

  caseTest("byte-snapshot-ordinary-bytes-safe", () => {
    const source = new Uint8Array([4, 5, 6]);
    const copy = snapshotByteView(source, "view");
    source[0] = 99;
    expect(copy[0]).toBe(4);
  });
}
