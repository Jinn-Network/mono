// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/trust-core";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { expect } from "vitest";

import { validateAuthorityResult } from "./authority-validation.js";
import { caseTest } from "./conformance-case-runner.js";
import { snapshotByteView } from "./byte-snapshot.js";
import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  TrajectoryDerivationSigningError,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TRAJECTORY_PROTOCOL, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { preflightCanonicalInput } from "./preflight.js";
import { parseTrajectory, sealTrajectory, TrajectoryRecordSchema } from "./schema.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";
import { InvalidDocumentError } from "./sealing.js";
import { snapshotSignerOutput } from "./signer-output-snapshot.js";

const SOURCE_SHA = "a".repeat(64);
const SOURCE_DIGEST = `sha256:${SOURCE_SHA}` as const;
const FORMAT_IRI = "https://jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const traceId = deriveTraceId({
  sourceDigest: SOURCE_DIGEST,
  formatIri: FORMAT_IRI,
  vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  ...DECODER,
});

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
    nativeTraceDigest: SOURCE_DIGEST,
    formatIri: FORMAT_IRI,
    decoderId: DECODER.decoderId,
    decoderVersion: DECODER.decoderVersion,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    timebase: "synthetic-ordinal" as const,
    linkageMode,
    derivedAt: "2026-07-31T12:00:00Z",
  };
}

function minimalGoldenDocument() {
  return {
    protocol: TRAJECTORY_PROTOCOL,
    source: {
      nativeTrace: {
        name: "stdout.jsonl",
        mediaType: "application/x-ndjson",
        digest: { sha256: SOURCE_SHA },
      },
      formatIri: FORMAT_IRI,
    },
    derivation: { ...DECODER, vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE },
    timebase: "synthetic-ordinal",
    traceId,
    spans: [
      {
        spanId: deriveSpanId(traceId, 0),
        parentSpanId: null,
        name: "chat anthropic/claude-opus-4.6",
        kind: SPAN_KIND.CLIENT,
        startTimeUnixNano: "0",
        endTimeUnixNano: "1",
        attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "anthropic" } }],
        events: [],
        status: { code: STATUS_CODE.OK },
      },
    ],
    completeness: { decoded: "full" },
  };
}

/** Registers C1-R57–R62 sixth exact-head reviewer probes on the public conformance kit. */
export function registerSixthReviewProbes(): void {
  caseTest("ajv-packed-uint64-max-plus-one-fails", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const span = {
      spanId: deriveSpanId(traceId, 0),
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "18446744073709551616",
      endTimeUnixNano: "1",
      attributes: [],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    const document = { ...minimalGoldenDocument(), spans: [span] };
    expect(validate(document)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(document).success).toBe(false);
  });

  caseTest("ajv-packed-int64-9464152666223001936-fails", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const span = {
      spanId: deriveSpanId(traceId, 0),
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "9464152666223001936" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    const document = { ...minimalGoldenDocument(), spans: [span] };
    expect(validate(document)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(document).success).toBe(false);
  });

  caseTest("preflight-revoked-extension-nested-proxy-fails", () => {
    const { proxy, revoke } = Proxy.revocable({ "network.jinn.note": "x" }, {});
    const document = {
      ...minimalGoldenDocument(),
      source: {
        ...minimalGoldenDocument().source,
        nativeTrace: {
          ...minimalGoldenDocument().source.nativeTrace,
          "network.jinn.note": proxy,
        },
      },
    };
    revoke();
    expect(() => preflightCanonicalInput(document)).toThrow();
  });

  caseTest("preflight-map-constructor-getter-zero", () => {
    let constructorCalls = 0;
    const map = new Map<string, string>();
    Object.defineProperty(map, "constructor", {
      get() {
        constructorCalls += 1;
        return Map;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      preflightCanonicalInput({
        protocol: "https://jinn.network/protocols/trajectory/1.0",
        source: {
          nativeTrace: { digest: { sha256: SOURCE_SHA }, name: "n" },
          formatIri: FORMAT_IRI,
          "network.jinn.nested": map,
        },
        derivation: { ...DECODER, vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE },
        timebase: "synthetic-ordinal",
        traceId: "0123456789abcdef0123456789abcdef",
        spans: [],
        completeness: { decoded: "empty" },
      }),
    ).toThrow();
    expect(constructorCalls).toBe(0);
  });

  caseTest("preflight-proxy-prototype-trap-zero", () => {
    let instanceofCalls = 0;
    const proxyPrototype = new Proxy(Object.prototype, {
      get(target, property, receiver) {
        if (property === Symbol.hasInstance) {
          instanceofCalls += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const extension = Object.create(proxyPrototype);
    Object.defineProperty(extension, "network.jinn.inner", {
      value: "x",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() =>
      preflightCanonicalInput({
        ...minimalGoldenDocument(),
        source: {
          ...minimalGoldenDocument().source,
          nativeTrace: {
            ...minimalGoldenDocument().source.nativeTrace,
            "network.jinn.note": extension,
          },
        },
      }),
    ).toThrow();
    expect(instanceofCalls).toBe(0);
  });

  caseTest("signer-output-subclass-array-fails", () => {
    class SubArray extends Array {}
    const hostile: unknown[] = [{ signature: new Uint8Array([1]), keyid: "k" }];
    Object.setPrototypeOf(hostile, SubArray.prototype);
    expect(() => snapshotSignerOutput(hostile)).toThrow(TrajectoryDerivationSigningError);
  });

  caseTest("authority-signer-key-ids-subclass-array-fails", () => {
    class SubArray extends Array {}
    const hostile: string[] = ["test-key"];
    Object.setPrototypeOf(hostile, SubArray.prototype);
    const result = validateAuthorityResult({ verified: true, signerKeyIds: hostile }, ["test-key"]);
    expect(result.ok).toBe(false);
  });

  caseTest("byte-snapshot-augmented-own-slice-fails", () => {
    const augmented = new Uint8Array([1]);
    Object.defineProperty(augmented, "slice", {
      value: () => new Uint8Array([9]),
      enumerable: true,
      configurable: true,
    });
    expect(() => snapshotByteView(augmented, "view")).toThrow(TypeError);
  });

  caseTest("byte-snapshot-augmented-own-length-fails", () => {
    const augmented = new Uint8Array([1]);
    Object.defineProperty(augmented, "length", {
      value: 99,
      enumerable: true,
      configurable: true,
    });
    expect(() => snapshotByteView(augmented, "view")).toThrow(TypeError);
  });

  caseTest("parse-trajectory-hostile-length-getter-zero", () => {
    const sealed = sealTrajectory(minimalGoldenDocument());
    let lengthGetterCalls = 0;
    const hostile = new Uint8Array(sealed.bytes);
    Object.defineProperty(hostile, "length", {
      get() {
        lengthGetterCalls += 1;
        return sealed.bytes.length;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => parseTrajectory(hostile)).toThrow(TypeError);
    expect(lengthGetterCalls).toBe(0);
  });

  caseTest("parse-trajectory-sab-view-fails", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const sab = new SharedArrayBuffer(8);
    expect(() => parseTrajectory(new Uint8Array(sab))).toThrow(TypeError);
  });

  caseTest("parse-trajectory-caller-mutation-immune", () => {
    const sealed = sealTrajectory(minimalGoldenDocument());
    const callerView = new Uint8Array(sealed.bytes);
    const parsed = parseTrajectory(callerView);
    callerView.fill(0);
    expect(parsed.traceId).toBe(traceId);
    expect(() => parseTrajectory(callerView)).toThrow(InvalidDocumentError);
  });

  caseTest("preflight-valid-plain-control-unchanged", () => {
    expect(() => preflightCanonicalInput(minimalGoldenDocument())).not.toThrow();
  });

  caseTest("verify-authority-custom-prototype-array-fails", async () => {
    class SubArray extends Array {}
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const result = await verifyTrajectoryDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: new TextEncoder().encode("{}"),
      trajectoryRecordBytes: new TextEncoder().encode("{}"),
      verifyAuthority: async () => {
        class SubArray extends Array {}
        const hostile: string[] = ["test-key"];
        Object.setPrototypeOf(hostile, SubArray.prototype);
        return { verified: true, signerKeyIds: hostile };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("l2-authority-malformed");
  });
}
