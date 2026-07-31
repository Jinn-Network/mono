import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";

import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  TrajectoryDerivationCancelledError,
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

function mutateEnvelopeBytes(
  envelopeBytes: Uint8Array,
  mutate: (envelope: Record<string, unknown>) => void,
): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as Record<string, unknown>;
  mutate(envelope);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

async function verifyWith(
  sealed: Awaited<ReturnType<typeof buildValidAttestation>>["sealed"],
  trajectorySealed: Awaited<ReturnType<typeof buildValidAttestation>>["trajectorySealed"],
  executionBytes: Uint8Array,
  options: {
    envelopeBytes?: Uint8Array;
    verifyAuthority?: Parameters<typeof verifyTrajectoryDerivationAttestation>[0]["verifyAuthority"];
    signal?: AbortSignal;
  } = {},
) {
  return verifyTrajectoryDerivationAttestation({
    envelopeBytes: options.envelopeBytes ?? sealed.envelopeBytes,
    executionRecordBytes: executionBytes,
    trajectoryRecordBytes: trajectorySealed.bytes,
    verifyAuthority:
      options.verifyAuthority ?? (async () => ({ verified: true, signerKeyIds: ["test-key"] })),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
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
    const executionBytes = new TextEncoder().encode(
      JSON.stringify(buildExecutionRecord(unfaithfulTrajectory.digest)),
    );
    const statement = buildTrajectoryDerivationStatement({
      producerId: "producer-1",
      executionDigest: documentDigest(executionBytes),
      trajectoryDigest: unfaithfulTrajectory.digest,
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
      executionRecordBytes: executionBytes,
      trajectoryRecordBytes: unfaithfulTrajectory.bytes,
      verifyAuthority: async () => ({ verified: true, signerKeyIds: ["test-key"] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
    }
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

describe("C1-R1 exact DSSE envelope identity", () => {
  test.each([
    ["undeclared envelope field", (e: Record<string, unknown>) => { e.extra = "bad"; }],
    ["undeclared signature field", (e: Record<string, unknown>) => {
      (e.signatures as Record<string, unknown>[])[0]!.forged = true;
    }],
    ["non-canonical payload base64", (e: Record<string, unknown>) => {
      e.payload = String(e.payload).replace(/=+$/, "");
    }],
  ])("%s fails L1 without calling authority", async (_label, mutate) => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const verifyAuthority = vi.fn();
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      envelopeBytes: mutateEnvelopeBytes(sealed.envelopeBytes, mutate),
      verifyAuthority,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedLayer).toBe(1);
      expect(result.layers.l1.status).toBe("fail");
    }
    expect(verifyAuthority).not.toHaveBeenCalled();
  });

  test("duplicate JSON key bytes fail L1 without calling authority", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const verifyAuthority = vi.fn();
    const text = new TextDecoder().decode(sealed.envelopeBytes);
    const injected = text.replace('"payloadType"', '"payloadType","payloadType"');
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      envelopeBytes: new TextEncoder().encode(injected),
      verifyAuthority,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedLayer).toBe(1);
    expect(verifyAuthority).not.toHaveBeenCalled();
  });
});

describe("C1-R2 unambiguous native-trace forward link", () => {
  test("duplicate native-trace File entities fail L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: (digest) => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native-a.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: digest,
            },
          },
          {
            "@id": "trace/native-b.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: digest,
            },
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-duplicate");
  });

  test("duplicate forward links on sole entity fail L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: (digest) => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: [
              {
                "@type": "PropertyValue",
                propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
                value: digest,
              },
              {
                "@type": "PropertyValue",
                propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
                value: digest,
              },
            ],
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-duplicate");
  });

  test("correct and wrong forward links on sole entity fail L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: (digest) => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: [
              {
                "@type": "PropertyValue",
                propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
                value: digest,
              },
              {
                "@type": "PropertyValue",
                propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
                value: `sha256:${"f".repeat(64)}`,
              },
            ],
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-duplicate");
  });

  test("malformed forward link value fails L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: () => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: "not-a-digest",
            },
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-mismatch");
  });

  test("wrong digest forward link fails L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: () => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native.bin",
            "@type": "File",
            sha256: SOURCE_SHA,
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: `sha256:${"e".repeat(64)}`,
            },
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-mismatch");
  });

  test("unrelated entity with correct link does not satisfy L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: (digest) => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/other.bin",
            "@type": "File",
            sha256: "b".repeat(64),
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: digest,
            },
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-missing");
  });

  test("wrong entity type with matching sha256 fails L3", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
      executionOverrides: (digest) => ({
        "@context": "https://w3id.org/ro/crate/1.3/context",
        "@graph": [
          {
            "@id": "trace/native.bin",
            "@type": "Dataset",
            sha256: SOURCE_SHA,
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: digest,
            },
          },
        ],
      }),
    });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l3-forward-link-missing");
  });
});

describe("C1-R3 authority result validation and cancellation", () => {
  test.each([
    ["string", "not-an-object"],
    ["number", 1],
    ["array", []],
    ["verified string", { verified: "true", signerKeyIds: ["test-key"] }],
    ["verified false without reason", { verified: false }],
    ["forged signerKeyIds", { verified: true, signerKeyIds: ["forged-key"] }],
    ["unknown key", { verified: true, signerKeyIds: ["test-key"], extra: "bad" }],
  ] as const)("malformed authority %s fails L2 as malformed", async (_label, value) => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      verifyAuthority: async () => value as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });

  test("authority callback throw fails L2 as error", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      verifyAuthority: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-error");
  });

  test("pre-aborted signal throws cancellation", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyWith(sealed, trajectorySealed, executionBytes, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationCancelledError);
  });

  test("abort during authority await throws cancellation", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const controller = new AbortController();
    await expect(
      verifyWith(sealed, trajectorySealed, executionBytes, {
        signal: controller.signal,
        verifyAuthority: async () => {
          controller.abort();
          return { verified: true, signerKeyIds: ["test-key"] };
        },
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationCancelledError);
  });

  test("AbortError from authority rethrows cancellation", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => {
          throw abort;
        },
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationCancelledError);
  });

  test("proxy authority result fails L2 malformed", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const proxy = new Proxy(
      { verified: true, signerKeyIds: ["test-key"] },
      {},
    );
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      verifyAuthority: async () => proxy,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });

  test("accessor authority result fails L2 malformed", async () => {
    const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
    const withGetter = {};
    Object.defineProperty(withGetter, "verified", {
      get: () => true,
      enumerable: true,
      configurable: true,
    });
    Object.assign(withGetter, { signerKeyIds: ["test-key"] });
    const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
      verifyAuthority: async () => withGetter as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });
});
