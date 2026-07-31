// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";

import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  TrajectoryDerivationCancelledError,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import {
  encodeExecutionDocument,
  loadExecutionGoldenBase,
  patchExecutionGolden,
} from "./execution-fixtures.js";
import { documentDigest } from "./hashing.js";
import {
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  TRAJECTORY_VOCABULARY_PROFILE,
  type LinkageMode,
} from "./identifiers.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { InvalidDocumentError } from "./sealing.js";
import { TrajectoryRecordSchema, sealTrajectory } from "./schema.js";
import { loadGoldenJson } from "./fixtures.js";
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

function buildStatementFields(
  trajectoryDigest: `sha256:${string}`,
  executionDigest: `sha256:${string}`,
  linkageMode: LinkageMode,
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
    derivedAt: DERIVED_AT,
  };
}

async function buildExecutionBytes(
  trajectoryDigest: `sha256:${string}`,
  linkageMode: LinkageMode,
  executionPatch?: (
    base: Record<string, unknown>,
    ctx: { trajectoryDigest: `sha256:${string}`; linkageMode: LinkageMode },
  ) => Record<string, unknown>,
): Promise<Uint8Array> {
  const goldenBase = await loadExecutionGoldenBase();
  const executionObject =
    executionPatch?.(goldenBase, { trajectoryDigest, linkageMode }) ??
    patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      trajectoryDigest,
      linkageMode,
    });
  return encodeExecutionDocument(executionObject);
}

async function buildValidAttestation(options: {
  trajectoryOverrides?: Record<string, unknown>;
  linkageMode?: LinkageMode;
  executionPatch?: (
    base: Record<string, unknown>,
    ctx: { trajectoryDigest: `sha256:${string}`; linkageMode: LinkageMode },
  ) => Record<string, unknown>;
} = {}) {
  const linkageMode = options.linkageMode ?? "forward-linked";
  const trajectorySealed = sealTrajectory(buildTrajectoryRecord(options.trajectoryOverrides));
  const executionBytes = await buildExecutionBytes(
    trajectorySealed.digest,
    linkageMode,
    options.executionPatch,
  );
  const statement = buildTrajectoryDerivationStatement(
    buildStatementFields(trajectorySealed.digest, documentDigest(executionBytes), linkageMode),
  );
  const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
  return { trajectorySealed, executionBytes, sealed, linkageMode };
}

function mutateEnvelopeBytes(
  envelopeBytes: Uint8Array,
  mutate: (envelope: Record<string, unknown>) => void,
): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as Record<string, unknown>;
  mutate(envelope);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function decodeEnvelopePayload(envelope: Record<string, unknown>): Uint8Array {
  return Uint8Array.from(Buffer.from(String(envelope.payload), "base64"));
}

function setEnvelopePayload(envelope: Record<string, unknown>, payloadBytes: Uint8Array): void {
  envelope.payload = Buffer.from(payloadBytes).toString("base64");
}

function mutatePayloadEncoding(
  envelopeBytes: Uint8Array,
  encode: (statement: unknown) => Uint8Array,
): Uint8Array {
  return mutateEnvelopeBytes(envelopeBytes, (envelope) => {
    const statement = JSON.parse(new TextDecoder().decode(decodeEnvelopePayload(envelope)));
    setEnvelopePayload(envelope, encode(statement));
  });
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

/** Public derivation-attestation attack matrix for packed conformance consumers. */
export function describeTrajectoryDerivationAttestationConformance(): void {
  describe("Trajectory derivation attestation conformance", () => {
    test("build rejects non-calendar-strict derivedAt", () => {
      expect(() =>
        buildTrajectoryDerivationStatement({
          ...buildStatementFields(
            `sha256:${"c".repeat(64)}`,
            `sha256:${"b".repeat(64)}`,
            "forward-linked",
          ),
          derivedAt: "2026-07-31",
        }),
      ).toThrow(InvalidDocumentError);
    });

    test("build rejects missing linkageMode", () => {
      const input = buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "forward-linked",
      );
      const { linkageMode: _removed, ...withoutMode } = input;
      expect(() => buildTrajectoryDerivationStatement(withoutMode as never)).toThrow(
        InvalidDocumentError,
      );
    });

    test("build input getter is not invoked during preflight", () => {
      let getterCalls = 0;
      const input = buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "forward-linked",
      );
      Object.defineProperty(input, "forged", {
        get: () => {
          getterCalls += 1;
          return "bad";
        },
        enumerable: true,
        configurable: true,
      });
      expect(() => buildTrajectoryDerivationStatement(input)).toThrow(InvalidDocumentError);
      expect(getterCalls).toBe(0);
    });

    test("malformed envelope fails L1 and does not call authority verifier", async () => {
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
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
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
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
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      const tamperedExecution = new Uint8Array(executionBytes);
      tamperedExecution[tamperedExecution.length - 2] ^= 0xff;
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
      const trajectorySealed = sealTrajectory(buildTrajectoryRecord());
      const goldenBase = await loadExecutionGoldenBase();
      const executionObject = patchExecutionGolden(goldenBase, {
        nativeTraceSha256: SOURCE_SHA,
        linkageMode: "forward-linked",
        trajectoryDigest: trajectorySealed.digest,
      });
      const graph = executionObject["@graph"] as Record<string, unknown>[];
      const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
      delete trace!.identifier;
      const executionBytes = encodeExecutionDocument(executionObject);
      const statement = buildTrajectoryDerivationStatement(
        buildStatementFields(
          trajectorySealed.digest,
          documentDigest(executionBytes),
          "forward-linked",
        ),
      );
      const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
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
          spans: [{ ...buildTrajectoryRecord().spans[0], name: "substituted span content" }],
        }),
      );
      const executionBytes = await buildExecutionBytes(
        unfaithfulTrajectory.digest,
        "forward-linked",
      );
      const statement = buildTrajectoryDerivationStatement(
        buildStatementFields(
          unfaithfulTrajectory.digest,
          documentDigest(executionBytes),
          "forward-linked",
        ),
      );
      const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
      const result = await verifyWith(sealed, unfaithfulTrajectory, executionBytes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
      }
    });

    test("sealed-parent golden execution passes L1-L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        linkageMode: "sealed-parent",
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(true);
    });

    test("forward link on sealed-parent fails L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        linkageMode: "sealed-parent",
        executionPatch: (base, ctx) =>
          patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            linkageMode: "forward-linked",
            trajectoryDigest: ctx.trajectoryDigest,
          }),
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-forward-link-present");
    });

    test("valid attestation passes L1-L3 and leaves L4 not-evaluated", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
        expect(result.signerKeyIds).toEqual(["test-key"]);
      }
    });
  });

  describe("exact DSSE envelope identity", () => {
    test.each([
      ["undeclared envelope field", (e: Record<string, unknown>) => { e.extra = "bad"; }],
      ["undeclared signature field", (e: Record<string, unknown>) => {
        (e.signatures as Record<string, unknown>[])[0]!.forged = true;
      }],
      ["non-canonical payload base64", (e: Record<string, unknown>) => {
        e.payload = `${String(e.payload).slice(0, -2)}==`;
      }],
    ])("%s fails L1 without calling authority", async (_label, mutate) => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        envelopeBytes: mutateEnvelopeBytes(sealed.envelopeBytes, mutate),
        verifyAuthority,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failedLayer).toBe(1);
      expect(verifyAuthority).not.toHaveBeenCalled();
    });

    test("duplicate JSON key bytes fail L1 without calling authority", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
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

  describe("statement payload canonical-byte equality", () => {
    test.each([
      ["pretty-printed payload", (statement: unknown) => new TextEncoder().encode(JSON.stringify(statement, null, 2))],
      ["reordered payload keys", (statement: unknown) => {
        const obj = statement as Record<string, unknown>;
        const reversed: Record<string, unknown> = {};
        for (const key of Object.keys(obj).reverse()) reversed[key] = obj[key];
        return new TextEncoder().encode(JSON.stringify(reversed));
      }],
      ["duplicate payload keys", (statement: unknown) => {
        const text = new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(statement)));
        return new TextEncoder().encode(
          text.replace(/"_type":"([^"]+)"/u, '"_type":"$1","_type":"$1"'),
        );
      }],
    ])("%s fails L1 without calling authority", async (_label, encode) => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        envelopeBytes: mutatePayloadEncoding(sealed.envelopeBytes, encode),
        verifyAuthority,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failedLayer).toBe(1);
        expect(result.code).toBe("l1-payload-noncanonical");
      }
      expect(verifyAuthority).not.toHaveBeenCalled();
    });
  });

  describe("unambiguous native-trace forward link", () => {
    test("decoy native-trace File with attestation naming decoy digest fails L3", async () => {
      const decoySha = "d".repeat(64);
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) =>
          patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
            decoyNativeTraceSha256: decoySha,
          }),
      });
      const statement = buildTrajectoryDerivationStatement({
        ...buildStatementFields(
          trajectorySealed.digest,
          documentDigest(executionBytes),
          "forward-linked",
        ),
        nativeTraceDigest: `sha256:${decoySha}`,
      });
      const decoySealed = await sealTrajectoryDerivationAttestation({
        statement,
        signer: fixedSigner,
      });
      const result = await verifyWith(decoySealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-source-mismatch");
    });

    test("duplicate forward links on primary native trace fail L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) => {
          const document = patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
          });
          const graph = document["@graph"] as Record<string, unknown>[];
          const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
          trace!.identifier = [
            {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: ctx.trajectoryDigest,
            },
            {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: ctx.trajectoryDigest,
            },
          ];
          return document;
        },
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-forward-link-duplicate");
    });

    test("correct and wrong forward links on primary native trace fail L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) => {
          const document = patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
          });
          const graph = document["@graph"] as Record<string, unknown>[];
          const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
          trace!.identifier = [
            {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: ctx.trajectoryDigest,
            },
            {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: `sha256:${"f".repeat(64)}`,
            },
          ];
          return document;
        },
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-forward-link-duplicate");
    });

    test("malformed forward link value fails L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) => {
          const document = patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
          });
          const graph = document["@graph"] as Record<string, unknown>[];
          const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
          trace!.identifier = {
            "@type": "PropertyValue",
            propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: "not-a-digest",
          };
          return document;
        },
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-forward-link-mismatch");
    });

    test("wrong digest forward link fails L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) => {
          const document = patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            linkageMode: "forward-linked",
            trajectoryDigest: ctx.trajectoryDigest,
          });
          const graph = document["@graph"] as Record<string, unknown>[];
          const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
          trace!.identifier = {
            "@type": "PropertyValue",
            propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: `sha256:${"e".repeat(64)}`,
          };
          return document;
        },
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-forward-link-mismatch");
    });

    test("attestation naming decoy digest while decoy carries forward link fails L3", async () => {
      const decoySha = "b".repeat(64);
      const { trajectorySealed, executionBytes } = await buildValidAttestation({
        executionPatch: (base, ctx) =>
          patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
            decoyNativeTraceSha256: decoySha,
          }),
      });
      const statement = buildTrajectoryDerivationStatement({
        ...buildStatementFields(
          trajectorySealed.digest,
          documentDigest(executionBytes),
          "forward-linked",
        ),
        nativeTraceDigest: `sha256:${decoySha}`,
      });
      const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-source-mismatch");
    });

    test("primary native trace with wrong entity type fails L3", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation({
        executionPatch: (base, ctx) => {
          const document = patchExecutionGolden(base, {
            nativeTraceSha256: SOURCE_SHA,
            trajectoryDigest: ctx.trajectoryDigest,
            linkageMode: "forward-linked",
          });
          const graph = document["@graph"] as Record<string, unknown>[];
          const trace = graph.find((entity) => entity["@id"] === "trace/trajectory.jsonl");
          trace!["@type"] = "Dataset";
          return document;
        },
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l3-native-trace-missing");
    });
  });

  describe("authority result validation and cancellation", () => {
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

    test("non-enumerable authority field fails L2 malformed without invoking getter", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      let getterCalls = 0;
      const resultObject: Record<string, unknown> = {
        verified: true,
        signerKeyIds: ["test-key"],
      };
      Object.defineProperty(resultObject, "hidden", {
        get: () => {
          getterCalls += 1;
          return "bad";
        },
        enumerable: false,
        configurable: true,
      });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => resultObject as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
      expect(getterCalls).toBe(0);
    });

    test("symbol authority key fails L2 malformed", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const resultObject: Record<string | symbol, unknown> = {
        verified: true,
        signerKeyIds: ["test-key"],
      };
      resultObject[Symbol("hidden")] = "bad";
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => resultObject as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
    });

    test("cyclic signerKeyIds array fails L2 malformed", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const cyclic: string[] = ["test-key"];
      cyclic.push(cyclic as unknown as string);
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => ({ verified: true, signerKeyIds: cyclic }) as never,
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
      const proxy = new Proxy({ verified: true, signerKeyIds: ["test-key"] }, {});
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => proxy as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
    });

    test("accessor authority result fails L2 malformed", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const withGetter: Record<string, unknown> = {};
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

  describe("R18-R20 port, array, and schema-law probes", () => {
    test("verify port accessor on envelopeBytes throws invalid-input without L1", async () => {
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      let getterCalls = 0;
      const input: Record<string, unknown> = {
        executionRecordBytes: new Uint8Array(),
        trajectoryRecordBytes: new Uint8Array(),
        verifyAuthority,
      };
      Object.defineProperty(input, "envelopeBytes", {
        get: () => {
          getterCalls += 1;
          return new Uint8Array([1]);
        },
        enumerable: true,
        configurable: true,
      });
      await expect(verifyTrajectoryDerivationAttestation(input as never)).rejects.toThrow(
        InvalidDocumentError,
      );
      expect(verifyAuthority).not.toHaveBeenCalled();
      expect(getterCalls).toBe(0);
    });

    test("sparse signerKeyIds fails L2 malformed", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const sparse: string[] = Array.from({ length: 2 });
      sparse[1] = "test-key";
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => ({ verified: true, signerKeyIds: sparse }) as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
    });

    test("augmented signerKeyIds fails L2 malformed", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const augmented = ["test-key"];
      Object.defineProperty(augmented, "extra", { value: "x", enumerable: true });
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => ({ verified: true, signerKeyIds: augmented }) as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
    });

    test("unknown statement field fails seal without calling signer", async () => {
      const statement = buildTrajectoryDerivationStatement(
        buildStatementFields(
          `sha256:${"c".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          "forward-linked",
        ),
      );
      const withUnknown = { ...statement, forged: "bad" };
      const signer = vi.fn(async () =>
        [{ signature: new Uint8Array([1]), keyid: "test-key" }] as const,
      );
      await expect(
        sealTrajectoryDerivationAttestation({ statement: withUnknown as never, signer }),
      ).rejects.toThrow();
      expect(signer).not.toHaveBeenCalled();
    });

    test("alternate payload escaping fails L1 without calling authority", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        envelopeBytes: mutatePayloadEncoding(sealed.envelopeBytes, (statement) =>
          new TextEncoder().encode(JSON.stringify(statement, null, 2)),
        ),
        verifyAuthority,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l1-payload-noncanonical");
      expect(verifyAuthority).not.toHaveBeenCalled();
    });
  });

  describe("R24-R29 packed kit probes", () => {
    test("TrajectoryRecordSchema.safeParse does not invoke hostile getters", async () => {
      let getterCalls = 0;
      const document = await loadGoldenJson("valid");
      Object.defineProperty(document, "forged", {
        get: () => {
          getterCalls += 1;
          return "bad";
        },
        enumerable: true,
        configurable: true,
      });
      expect(TrajectoryRecordSchema.safeParse(document).success).toBe(false);
      expect(getterCalls).toBe(0);
    });

    test("non-callable verifyAuthority fails verify port before L1", async () => {
      const verifyAuthority = vi.fn();
      let getterCalls = 0;
      const input: Record<string, unknown> = {
        envelopeBytes: new Uint8Array([1]),
        executionRecordBytes: new Uint8Array(),
        trajectoryRecordBytes: new Uint8Array(),
      };
      Object.defineProperty(input, "verifyAuthority", {
        get: () => {
          getterCalls += 1;
          return "not-a-function";
        },
        enumerable: true,
        configurable: true,
      });
      await expect(verifyTrajectoryDerivationAttestation(input as never)).rejects.toThrow(
        InvalidDocumentError,
      );
      expect(verifyAuthority).not.toHaveBeenCalled();
      expect(getterCalls).toBe(0);
    });

    test("proxy-throwing authority error normalizes without instanceof", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      let descriptorTraps = 0;
      let prototypeTraps = 0;
      const result = await verifyWith(sealed, trajectorySealed, executionBytes, {
        verifyAuthority: async () => {
          throw new Proxy(new Error("hostile"), {
            getOwnPropertyDescriptor(target, property) {
              descriptorTraps += 1;
              return Reflect.getOwnPropertyDescriptor(target, property);
            },
            getPrototypeOf(target) {
              prototypeTraps += 1;
              return Reflect.getPrototypeOf(target);
            },
          });
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("l2-authority-error");
      expect(descriptorTraps).toBe(0);
      expect(prototypeTraps).toBe(0);
    });

    test("genuine AbortSignal with own aborted getter uses native cancellation state", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      const controller = new AbortController();
      let ownAbortedGetterCalls = 0;
      Object.defineProperty(controller.signal, "aborted", {
        get: () => {
          ownAbortedGetterCalls += 1;
          return false;
        },
        configurable: true,
      });
      controller.abort();
      await expect(
        verifyWith(sealed, trajectorySealed, executionBytes, {
          signal: controller.signal,
          verifyAuthority,
        }),
      ).rejects.toBeInstanceOf(TrajectoryDerivationCancelledError);
      expect(verifyAuthority).not.toHaveBeenCalled();
      expect(ownAbortedGetterCalls).toBe(0);
    });

    test("fake AbortSignal with getter aborted is rejected before authority", async () => {
      const { trajectorySealed, executionBytes, sealed } = await buildValidAttestation();
      const verifyAuthority = vi.fn(async () =>
        ({ verified: true as const, signerKeyIds: ["test-key"] }),
      );
      let abortedGetterCalls = 0;
      const fakeSignal = {};
      Object.defineProperty(fakeSignal, "aborted", {
        get: () => {
          abortedGetterCalls += 1;
          return false;
        },
        enumerable: true,
        configurable: true,
      });
      await expect(
        verifyWith(sealed, trajectorySealed, executionBytes, {
          signal: fakeSignal as AbortSignal,
          verifyAuthority,
        }),
      ).rejects.toThrow(InvalidDocumentError);
      expect(verifyAuthority).not.toHaveBeenCalled();
      expect(abortedGetterCalls).toBe(0);
    });
  });
}
