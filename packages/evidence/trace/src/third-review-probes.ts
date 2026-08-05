// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/trust-core";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, vi } from "vitest";

import { caseTest } from "./conformance-case-runner.js";
import {
  buildTraceDerivationStatement,
  sealTraceDerivationAttestation,
  TraceDerivationCancelledError,
  TraceDerivationStatementSchema,
  verifyTraceDerivationAttestation,
} from "./derivation.js";
import {
  encodeExecutionDocument,
  loadExecutionGoldenBase,
  patchExecutionGolden,
} from "./execution-fixtures.js";
import { resolvePrimaryNativeTrace, verifyExecutionLinkage } from "./execution-linkage.js";
import { documentDigest } from "./hashing.js";
import {
  TRACE_DERIVATION_STATEMENT_SCHEMA,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
  TRACE_VOCABULARY_PROFILE,
} from "./identifiers.js";
import { UnsupportedCanonicalValueError } from "./canonical.js";
import { preflightCanonicalInput } from "./preflight.js";
import { JsonExtensionValueSchema } from "./extensions.js";
import { sealTrace } from "./schema.js";
import { SpanSchema } from "./span.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";

const SOURCE_SHA = "a".repeat(64);
const FORMAT_IRI = "https://spec.jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

function buildStatementFields(
  traceDigest: `sha256:${string}`,
  executionDigest: `sha256:${string}`,
  linkageMode: "forward-linked" | "sealed-parent",
) {
  return {
    producerId: "producer-1",
    executionDigest,
    traceDigest,
    nativeTraceDigest: `sha256:${SOURCE_SHA}` as const,
    formatIri: FORMAT_IRI,
    decoderId: DECODER.decoderId,
    decoderVersion: DECODER.decoderVersion,
    vocabularyProfile: TRACE_VOCABULARY_PROFILE,
    timebase: "synthetic-ordinal" as const,
    linkageMode,
    derivedAt: "2026-07-31T12:00:00Z",
  };
}

function buildTraceRecord() {
  const traceId = deriveTraceId({
    sourceDigest: `sha256:${SOURCE_SHA}`,
    formatIri: FORMAT_IRI,
    vocabularyProfile: TRACE_VOCABULARY_PROFILE,
    ...DECODER,
  });
  return {
    protocol: "https://spec.jinn.network/protocols/trace/v1",
    source: {
      nativeTrace: { digest: { sha256: SOURCE_SHA }, name: "stdout.jsonl" },
      formatIri: FORMAT_IRI,
    },
    derivation: { ...DECODER, vocabularyProfile: TRACE_VOCABULARY_PROFILE },
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
  };
}

/** Registers C1-R31–R38 exact-head reviewer probes on the public conformance kit. */
export function registerThirdReviewProbes(): void {
  caseTest("preflight-getPrototypeOf-trap-before-instanceof", () => {
    let prototypeTraps = 0;
    const trapped = new Proxy(
      { nested: { a: 1 } },
      {
        getPrototypeOf() {
          prototypeTraps += 1;
          throw new Error("getPrototypeOf trap");
        },
      },
    );
    expect(() => preflightCanonicalInput({ root: trapped })).toThrow(UnsupportedCanonicalValueError);
    expect(prototypeTraps).toBe(0);
  });

  caseTest("span-schema-proxy-trap-zero", () => {
    let getterCalls = 0;
    const span = {
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
    Object.defineProperty(span, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    expect(SpanSchema.safeParse(span).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  caseTest("json-extension-schema-proxy-trap-zero", () => {
    let getterCalls = 0;
    const value = { "network.jinn.note": "ok" };
    Object.defineProperty(value, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    expect(JsonExtensionValueSchema.safeParse(value).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  caseTest("seal-pre-abort-signer-uncalled", async () => {
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "forward-linked",
      ),
    );
    const signer = vi.fn(fixedSigner);
    const controller = new AbortController();
    controller.abort();
    await expect(
      sealTraceDerivationAttestation({
        statement,
        signer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TraceDerivationCancelledError);
    expect(signer).not.toHaveBeenCalled();
  });

  caseTest("seal-signer-abort-error-cancellation", async () => {
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "forward-linked",
      ),
    );
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      sealTraceDerivationAttestation({
        statement,
        signer: async () => {
          throw abort;
        },
      }),
    ).rejects.toBeInstanceOf(TraceDerivationCancelledError);
  });

  caseTest("signer-mutates-callback-bytes-envelope-canonical", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const executionObject = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const executionBytes = encodeExecutionDocument(executionObject);
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        traceSealed.digest,
        documentDigest(executionBytes),
        "forward-linked",
      ),
    );
    const sealed = await sealTraceDerivationAttestation({
      statement,
      signer: async (request) => {
        request.payloadBytes.fill(0xff);
        request.preAuthEncoding.fill(0xff);
        return fixedSigner(request);
      },
    });
    const payload = JSON.parse(new TextDecoder().decode(sealed.payloadBytes));
    expect(payload.predicateType).toBe(
      "https://spec.jinn.network/attestations/trace-derivation/v1",
    );
  });

  caseTest("authority-mutates-callback-bytes-digest-unchanged", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const executionObject = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const executionBytes = encodeExecutionDocument(executionObject);
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        traceSealed.digest,
        documentDigest(executionBytes),
        "forward-linked",
      ),
    );
    const sealed = await sealTraceDerivationAttestation({ statement, signer: fixedSigner });
    const callerEnvelope = sealed.envelopeBytes.slice();
    const callerExecution = executionBytes.slice();
    const callerTrace = traceSealed.bytes.slice();
    const expectedDigest = documentDigest(callerExecution);
    const result = await verifyTraceDerivationAttestation({
      envelopeBytes: sealed.envelopeBytes,
      executionRecordBytes: executionBytes,
      traceRecordBytes: traceSealed.bytes,
      verifyAuthority: async (input) => {
        input.envelopeBytes.fill(0xaa);
        input.payloadBytes.fill(0xbb);
        input.preAuthEncoding.fill(0xcc);
        return { verified: true, signerKeyIds: ["test-key"] };
      },
    });
    expect(result.ok).toBe(true);
    expect(documentDigest(callerExecution)).toBe(expectedDigest);
    expect(callerEnvelope).toEqual(sealed.envelopeBytes);
    expect(callerExecution).toEqual(executionBytes);
    expect(callerTrace).toEqual(traceSealed.bytes);
  });

  caseTest("subjectOf-singleton-array-passes", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const document = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const graph = document["@graph"] as Record<string, unknown>[];
    const execution = graph.find(
      (entity) => entity["@id"] === "urn:uuid:22222222-2222-4222-8222-222222222222",
    )!;
    execution["subjectOf"] = [{ "@id": "trace/trace.jsonl" }];
    const executionBytes = encodeExecutionDocument(document);
    const resolved = resolvePrimaryNativeTrace(executionBytes);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const linkage = verifyExecutionLinkage(
        executionBytes,
        resolved.nativeTraceHex,
        traceSealed.digest,
        "forward-linked",
      );
      expect(linkage.code).toBeUndefined();
    }
  });

  caseTest("subjectOf-empty-array-fails", async () => {
    const goldenBase = await loadExecutionGoldenBase();
    const document = structuredClone(goldenBase) as Record<string, unknown>;
    const graph = document["@graph"] as Record<string, unknown>[];
    const execution = graph.find(
      (entity) => entity["@id"] === "urn:uuid:22222222-2222-4222-8222-222222222222",
    )!;
    execution["subjectOf"] = [];
    expect(() => encodeExecutionDocument(document)).toThrow(/nonconforming|TRACE_CARDINALITY/u);
  });

  caseTest("subjectOf-multi-distinct-fails", async () => {
    const goldenBase = await loadExecutionGoldenBase();
    const document = structuredClone(goldenBase) as Record<string, unknown>;
    const graph = document["@graph"] as Record<string, unknown>[];
    graph.push({
      "@id": "trace/other.bin",
      "@type": "File",
      sha256: "b".repeat(64),
    });
    const execution = graph.find(
      (entity) => entity["@id"] === "urn:uuid:22222222-2222-4222-8222-222222222222",
    )!;
    execution["subjectOf"] = [{ "@id": "trace/trace.jsonl" }, { "@id": "trace/other.bin" }];
    expect(() => encodeExecutionDocument(document)).toThrow(/nonconforming|TRACE_CARDINALITY/u);
  });

  caseTest("forward-link-missing-propertyvalue-type-fails", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const document = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const graph = document["@graph"] as Record<string, unknown>[];
    const trace = graph.find((entity) => entity["@id"] === "trace/trace.jsonl")!;
    trace["identifier"] = {
      propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
      value: traceSealed.digest,
    };
    const executionBytes = encodeExecutionDocument(document);
    const resolved = resolvePrimaryNativeTrace(executionBytes);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const linkage = verifyExecutionLinkage(
        executionBytes,
        resolved.nativeTraceHex,
        traceSealed.digest,
        "forward-linked",
      );
      expect(linkage.code).toBe("l3-forward-link-malformed");
    }
  });

  caseTest("forward-link-wrong-type-thing-fails", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const document = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const graph = document["@graph"] as Record<string, unknown>[];
    const trace = graph.find((entity) => entity["@id"] === "trace/trace.jsonl")!;
    trace["identifier"] = {
      "@type": "Thing",
      propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
      value: traceSealed.digest,
    };
    const executionBytes = encodeExecutionDocument(document);
    const resolved = resolvePrimaryNativeTrace(executionBytes);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const linkage = verifyExecutionLinkage(
        executionBytes,
        resolved.nativeTraceHex,
        traceSealed.digest,
        "forward-linked",
      );
      expect(linkage.code).toBe("l3-forward-link-malformed");
    }
  });

  caseTest("forward-link-valid-plus-malformed-fails", async () => {
    const traceSealed = sealTrace(buildTraceRecord());
    const goldenBase = await loadExecutionGoldenBase();
    const document = patchExecutionGolden(goldenBase, {
      nativeTraceSha256: SOURCE_SHA,
      traceDigest: traceSealed.digest,
      linkageMode: "forward-linked",
    });
    const graph = document["@graph"] as Record<string, unknown>[];
    const trace = graph.find((entity) => entity["@id"] === "trace/trace.jsonl")!;
    trace["identifier"] = [
      {
        "@type": "PropertyValue",
        propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
        value: traceSealed.digest,
      },
      {
        "@type": "Thing",
        propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
        value: traceSealed.digest,
      },
    ];
    const executionBytes = encodeExecutionDocument(document);
    const resolved = resolvePrimaryNativeTrace(executionBytes);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const linkage = verifyExecutionLinkage(
        executionBytes,
        resolved.nativeTraceHex,
        traceSealed.digest,
        "forward-linked",
      );
      expect(linkage.code).toBe("l3-forward-link-malformed");
    }
  });

  caseTest("otlp-uint64-max-boundary-pass", () => {
    const span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "18446744073709551615",
      endTimeUnixNano: "18446744073709551615",
      attributes: [],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  caseTest("otlp-uint64-overflow-fails", () => {
    const span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "18446744073709551616",
      endTimeUnixNano: "1",
      attributes: [],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(SpanSchema.safeParse(span).success).toBe(false);
  });

  caseTest("otlp-int64-max-boundary-pass", () => {
    const span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "9223372036854775807" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  caseTest("otlp-int64-overflow-fails", () => {
    const span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "9223372036854775808" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(SpanSchema.safeParse(span).success).toBe(false);
  });

  caseTest("otlp-int64-minus-zero-pass", () => {
    const span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "-0" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  caseTest("derivation-statement-schema-ajv-forward-linked", async () => {
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "forward-linked",
      ),
    );
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trace-derivation-statement.schema.json", import.meta.url), "utf8"),
    );
    expect(schema.$id).toBe(TRACE_DERIVATION_STATEMENT_SCHEMA);
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    expect(validate(statement)).toBe(true);
    expect(TraceDerivationStatementSchema.safeParse(statement).success).toBe(true);
  });

  caseTest("derivation-statement-schema-ajv-sealed-parent", async () => {
    const statement = buildTraceDerivationStatement(
      buildStatementFields(
        `sha256:${"c".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "sealed-parent",
      ),
    );
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trace-derivation-statement.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    expect(validate(statement)).toBe(true);
    expect(TraceDerivationStatementSchema.safeParse(statement).success).toBe(true);
  });
}
