// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/trust-core";
import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { expect } from "vitest";

import { caseTest } from "./conformance-case-runner.js";
import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  TrajectoryDerivationCancelledError,
  TrajectoryDerivationSigningError,
  TrajectoryDerivationStatementSchema,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import { sha256Hex } from "./hashing.js";
import { deriveTraceId } from "./identity.js";
import { TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { UnsupportedCanonicalValueError } from "./canonical.js";
import { preflightCanonicalInput } from "./preflight.js";
import { SPAN_KIND, STATUS_CODE, SpanSchema } from "./span.js";

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

function minimalRecord(span: Record<string, unknown>) {
  return {
    protocol: "https://jinn.network/protocols/trajectory/1.0",
    source: {
      nativeTrace: { digest: { sha256: SOURCE_SHA }, name: "n" },
      formatIri: FORMAT_IRI,
    },
    derivation: { ...DECODER, vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE },
    timebase: "synthetic-ordinal",
    traceId: "a".repeat(32),
    spans: [span],
    completeness: { decoded: "full" },
  };
}

function baseSpan() {
  return {
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "x",
    kind: SPAN_KIND.CLIENT,
    startTimeUnixNano: "0",
    endTimeUnixNano: "1",
    attributes: [],
    events: [],
    status: { code: STATUS_CODE.OK },
  };
}

/** Registers C1-R42–R45 fourth exact-head reviewer probes on the public conformance kit. */
export function registerFourthReviewProbes(): void {
  caseTest("ajv-packed-int64-overflow-fails", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const span = {
      ...baseSpan(),
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "9223372036854775808" } }],
    };
    expect(validate(minimalRecord(span))).toBe(false);
    expect(SpanSchema.safeParse(span).success).toBe(false);
  });

  caseTest("ajv-packed-int64-min-boundary-pass", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const span = {
      ...baseSpan(),
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "-9223372036854775808" } }],
    };
    expect(validate(minimalRecord(span))).toBe(true);
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  caseTest("statement-schema-subject-empty-fails", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/trajectory-derivation-statement.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const emptySubject = { ...statement, subject: [] };
    expect(validate(emptySubject)).toBe(false);
    expect(TrajectoryDerivationStatementSchema.safeParse(emptySubject).success).toBe(false);
  });

  caseTest("statement-schema-subject-two-fails", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/trajectory-derivation-statement.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const twoSubjects = { ...statement, subject: [...statement.subject, ...statement.subject] };
    expect(validate(twoSubjects)).toBe(false);
    expect(TrajectoryDerivationStatementSchema.safeParse(twoSubjects).success).toBe(false);
  });

  caseTest("statement-schema-derived-at-invalid-fails", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/trajectory-derivation-statement.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ strict: false });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value) => isCalendarStrictRfc3339(value),
    });
    const validate = ajv.compile(schema);
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const invalid = {
      ...statement,
      predicate: { ...statement.predicate, derivedAt: "2026-02-29T12:00:00Z" },
    };
    expect(validate(invalid)).toBe(false);
    expect(TrajectoryDerivationStatementSchema.safeParse(invalid).success).toBe(false);
  });

  caseTest("statement-schema-derived-at-feb29-non-leap-fails", () => {
    const invalid = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "trajectory.json",
          digest: { sha256: "c".repeat(64) },
          mediaType: "application/vnd.jinn.trajectory.v1+json",
        },
      ],
      predicateType: "https://jinn.network/attestations/trajectory-derivation/v1",
      predicate: {
        derivedAt: "2025-02-29T12:00:00Z",
        producer: { id: "p" },
        trajectorySubject: "trajectory.json",
        execution: { name: "execution.json", digest: { sha256: "b".repeat(64) } },
        nativeTrace: { name: "native-trace.bin", digest: { sha256: SOURCE_SHA } },
        formatIri: FORMAT_IRI,
        decoderId: DECODER.decoderId,
        decoderVersion: DECODER.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
        timebase: "synthetic-ordinal",
        linkageMode: "forward-linked",
      },
    };
    expect(TrajectoryDerivationStatementSchema.safeParse(invalid).success).toBe(false);
  });

  caseTest("statement-schema-derived-at-leap-day-pass", () => {
    const valid = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "trajectory.json",
          digest: { sha256: "c".repeat(64) },
          mediaType: "application/vnd.jinn.trajectory.v1+json",
        },
      ],
      predicateType: "https://jinn.network/attestations/trajectory-derivation/v1",
      predicate: {
        derivedAt: "2024-02-29T12:00:00Z",
        producer: { id: "p" },
        trajectorySubject: "trajectory.json",
        execution: { name: "execution.json", digest: { sha256: "b".repeat(64) } },
        nativeTrace: { name: "native-trace.bin", digest: { sha256: SOURCE_SHA } },
        formatIri: FORMAT_IRI,
        decoderId: DECODER.decoderId,
        decoderVersion: DECODER.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
        timebase: "synthetic-ordinal",
        linkageMode: "forward-linked",
      },
    };
    expect(TrajectoryDerivationStatementSchema.safeParse(valid).success).toBe(true);
  });

  caseTest("preflight-revoked-proxy-typed-invalid", () => {
    const { proxy, revoke } = Proxy.revocable({ nested: { a: 1 } }, {});
    revoke();
    expect(() => preflightCanonicalInput({ root: proxy })).toThrow(UnsupportedCanonicalValueError);
  });

  caseTest("build-port-revoked-proxy-typed-invalid", () => {
    const { proxy, revoke } = Proxy.revocable(
      {
        producerId: "p",
        executionDigest: `sha256:${"b".repeat(64)}`,
        trajectoryDigest: `sha256:${"c".repeat(64)}`,
        nativeTraceDigest: `sha256:${SOURCE_SHA}`,
        formatIri: FORMAT_IRI,
        decoderId: DECODER.decoderId,
        decoderVersion: DECODER.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
        timebase: "synthetic-ordinal",
        linkageMode: "forward-linked",
        derivedAt: "2026-07-31T12:00:00Z",
      },
      {},
    );
    revoke();
    expect(() => buildTrajectoryDerivationStatement(proxy as never)).toThrow(InvalidDocumentError);
  });

  caseTest("deriveTraceId-hostile-getter-trap-zero", () => {
    let getterCalls = 0;
    const input = {
      sourceDigest: `sha256:${SOURCE_SHA}`,
      formatIri: FORMAT_IRI,
      decoderId: DECODER.decoderId,
      decoderVersion: DECODER.decoderVersion,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    };
    Object.defineProperty(input, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => deriveTraceId(input)).toThrow(InvalidDocumentError);
    expect(getterCalls).toBe(0);
  });

  caseTest("sha256Hex-prototype-trap-rejects", () => {
    let prototypeTraps = 0;
    const trapped = new Proxy(new Uint8Array([1, 2, 3]), {
      getPrototypeOf() {
        prototypeTraps += 1;
        throw new Error("getPrototypeOf trap");
      },
    });
    expect(() => sha256Hex(trapped)).toThrow(TypeError);
    expect(prototypeTraps).toBe(0);
  });

  caseTest("seal-signer-throws-symbol-typed-signing-error", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    await expect(
      sealTrajectoryDerivationAttestation({
        statement,
        signer: async () => {
          throw Symbol("hostile");
        },
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationSigningError);
  });

  caseTest("authority-abort-signal-then-ordinary-throw-cancellation", async () => {
    const statement = buildTrajectoryDerivationStatement(
      buildStatementFields(`sha256:${"c".repeat(64)}`, `sha256:${"b".repeat(64)}`, "forward-linked"),
    );
    const sealed = await sealTrajectoryDerivationAttestation({ statement, signer: fixedSigner });
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyTrajectoryDerivationAttestation({
        envelopeBytes: sealed.envelopeBytes,
        executionRecordBytes: new TextEncoder().encode("{}"),
        trajectoryRecordBytes: new TextEncoder().encode("{}"),
        verifyAuthority: async () => {
          throw new Error("ordinary authority failure");
        },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TrajectoryDerivationCancelledError);
  });
}
