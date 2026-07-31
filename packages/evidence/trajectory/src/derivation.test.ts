import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";

import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import { documentDigest } from "./hashing.js";
import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { InvalidDocumentError } from "./sealing.js";
import { sealTrajectory } from "./schema.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

const SOURCE_SHA = "a".repeat(64);
const FORMAT_IRI = "https://jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };
const DERIVED_AT = "2026-07-31T12:00:00Z";

function buildTrajectoryRecord(overrides: Record<string, unknown> = {}) {
  const traceId = deriveTraceId({
    sourceDigest: `sha256:${SOURCE_SHA}`,
    formatIri: FORMAT_IRI,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    ...DECODER,
  });
  return {
    protocol: "https://jinn.network/protocols/trajectory/1.0",
    source: {
      nativeTrace: {
        digest: { sha256: SOURCE_SHA },
        name: "stdout.jsonl",
      },
      formatIri: FORMAT_IRI,
    },
    derivation: {
      ...DECODER,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    },
    timebase: "synthetic-ordinal",
    traceId,
    spans: [
      {
        spanId: deriveSpanId(traceId, 0),
        parentSpanId: null,
        name: "chat",
        kind: SPAN_KIND.CLIENT,
        startTimeUnixNano: "0",
        endTimeUnixNano: "1",
        attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "anthropic" } }],
        events: [],
        status: { code: STATUS_CODE.OK },
      },
    ],
    completeness: { decoded: "full" },
    ...overrides,
  };
}

function buildExecutionRecord(trajectoryDigest: `sha256:${string}`) {
  return {
    "@context": "https://w3id.org/ro/crate/1.3/context",
    "@graph": [
      {
        "@id": "trace/native.bin",
        "@type": "File",
        sha256: SOURCE_SHA,
        identifier: {
          "@type": "PropertyValue",
          propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
          value: trajectoryDigest,
        },
      },
    ],
  };
}

async function buildValidAttestation(options: {
  trajectoryOverrides?: Record<string, unknown>;
  executionOverrides?: (trajectoryDigest: `sha256:${string}`) => unknown;
} = {}) {
  const trajectorySealed = sealTrajectory(buildTrajectoryRecord(options.trajectoryOverrides));
  const executionObject =
    options.executionOverrides?.(trajectorySealed.digest) ??
    buildExecutionRecord(trajectorySealed.digest);
  const executionBytes = new TextEncoder().encode(JSON.stringify(executionObject));
  const statement = buildTrajectoryDerivationStatement({
    producerId: "producer-1",
    executionDigest: documentDigest(executionBytes),
    trajectoryDigest: trajectorySealed.digest,
    nativeTraceDigest: `sha256:${SOURCE_SHA}`,
    formatIri: FORMAT_IRI,
    decoderId: DECODER.decoderId,
    decoderVersion: DECODER.decoderVersion,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    timebase: "synthetic-ordinal",
    derivedAt: DERIVED_AT,
  });
  const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
  return { trajectorySealed, executionBytes, sealed };
}

describe("trajectory derivation attestation", () => {
  test("build rejects non-calendar-strict derivedAt", () => {
    expect(() =>
      buildTrajectoryDerivationStatement({
        producerId: "producer-1",
        executionDigest: `sha256:${"b".repeat(64)}`,
        trajectoryDigest: `sha256:${"c".repeat(64)}`,
        nativeTraceDigest: `sha256:${SOURCE_SHA}`,
        formatIri: FORMAT_IRI,
        decoderId: DECODER.decoderId,
        decoderVersion: DECODER.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
        timebase: "synthetic-ordinal",
        derivedAt: "2026-07-31",
      }),
    ).toThrow(InvalidDocumentError);
  });

  test("malformed envelope fails L1 and does not call authority verifier", async () => {
    const verifyAuthority = vi.fn();
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: new TextEncoder().encode("{not-json"),
      executionRecordBytes: new Uint8Array(),
      trajectoryRecordBytes: new Uint8Array(),
      verifyAuthority,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(1);
      expect(result.layers.l1.status).toBe("fail");
      expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
    }
    expect(verifyAuthority).not.toHaveBeenCalled();
  });

  test("authority verified:false fails L2", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: executionBytes,
      trajectoryRecordBytes: trajectorySealed.bytes,
      verifyAuthority: async () => ({ verified: false, reason: "bad signature" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(2);
      expect(result.code).toBe("l2-authority-rejected");
    }
  });

  test("bad execution digest fails L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: executionBytes,
      trajectoryRecordBytes: trajectorySealed.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    const tamperedExecution = new TextEncoder().encode(
      JSON.stringify(buildExecutionRecord(trajectorySealed.digest)).replace(SOURCE_SHA, "b".repeat(64)),
    );
    const tampered = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: tamperedExecution,
      trajectoryRecordBytes: trajectorySealed.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(true);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.code).toBe("l3-execution-digest-mismatch");
  });

  test("missing forward link fails L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: () => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [{ "@id": "trace/native.bin", "@type": "File", sha256: SOURCE_SHA }],
      }),
    });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: executionBytes,
      trajectoryRecordBytes: trajectorySealed.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-missing");
  });

  test("signed-but-unfaithful spans pass L1-L3 with L4 not-evaluated", async () => {
    const faithful = await buildValidAttestation();
    const unfaithfulTrajectory = sealTrajectory(
      buildTrajectoryRecord({
        spans: [
          {
            ...buildTrajectoryRecord().spans[0],
            name: "substituted span content",
          },
        ],
      }),
    );
    const statement = buildTrajectoryDerivationStatement({
      producerId: "producer-1",
      executionDigest: documentDigest(faithful.executionBytes),
      trajectoryDigest: faithful.trajectorySealed.digest,
      nativeTraceDigest: `sha256:${SOURCE_SHA}`,
      formatIri: FORMAT_IRI,
      decoderId: DECODER.decoderId,
      decoderVersion: DECODER.decoderVersion,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
      timebase: "synthetic-ordinal",
      derivedAt: DERIVED_AT,
    });
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: faithful.executionBytes,
      trajectoryRecordBytes: unfaithfulTrajectory.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-trajectory-digest-mismatch");
  });

  test("valid attestation passes L1-L3 and leaves L4 not-evaluated", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: executionBytes,
      trajectoryRecordBytes: trajectorySealed.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
      expect(result.signerKeyIds).toEqual(["test-key"]);
    }
  });
});
