// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import vm from "node:vm";

import Ajv2020 from "ajv/dist/2020.js";
import { expect } from "vitest";

import { caseTest } from "./conformance-case-runner.js";
import { snapshotByteView } from "./byte-snapshot.js";
import { loadGoldenJson } from "./fixtures.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TRACE_PROTOCOL, TRACE_VOCABULARY_PROFILE } from "./identifiers.js";
import { sha256Hex } from "./hashing.js";
import { preflightCanonicalInput } from "./preflight.js";
import { parseTrace, sealTrace, TraceRecordSchema } from "./schema.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";
import { InvalidDocumentError } from "./sealing.js";
import { UnsupportedCanonicalValueError } from "./canonical.js";

const SOURCE_SHA = "a".repeat(64);
const SOURCE_DIGEST = `sha256:${SOURCE_SHA}` as const;
const FORMAT_IRI = "https://spec.jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const traceId = deriveTraceId({
  sourceDigest: SOURCE_DIGEST,
  formatIri: FORMAT_IRI,
  vocabularyProfile: TRACE_VOCABULARY_PROFILE,
  ...DECODER,
});

function documentWithExtension(value: unknown) {
  return {
    protocol: TRACE_PROTOCOL,
    source: {
      nativeTrace: {
        name: "stdout.jsonl",
        mediaType: "application/x-ndjson",
        digest: { sha256: SOURCE_SHA },
        "network.jinn.tags": value,
      },
      formatIri: FORMAT_IRI,
    },
    derivation: { ...DECODER, vocabularyProfile: TRACE_VOCABULARY_PROFILE },
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

async function ajvAccepts(document: unknown): Promise<boolean> {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/trace.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  return validate(document) === true;
}

/** Registers C1-R63–R65 seventh exact-head reviewer probes on the public conformance kit. */
export function registerSeventhReviewProbes(): void {
  caseTest("extension-value-array-simple-pass", () => {
    const document = documentWithExtension(["alpha", "beta"]);
    expect(() => preflightCanonicalInput(document)).not.toThrow();
    expect(TraceRecordSchema.safeParse(document).success).toBe(true);
  });

  caseTest("extension-value-nested-arrays-pass", () => {
    const document = documentWithExtension([["alpha"], ["beta", "gamma"]]);
    expect(() => preflightCanonicalInput(document)).not.toThrow();
    expect(TraceRecordSchema.safeParse(document).success).toBe(true);
  });

  caseTest("extension-value-array-of-objects-pass", () => {
    const document = documentWithExtension([{ "network.jinn.note": "one" }, { "network.jinn.note": "two" }]);
    expect(() => preflightCanonicalInput(document)).not.toThrow();
    expect(TraceRecordSchema.safeParse(document).success).toBe(true);
  });

  caseTest("extension-value-mixed-scalars-pass", () => {
    const document = documentWithExtension(["text", 42, true, null]);
    expect(() => preflightCanonicalInput(document)).not.toThrow();
    expect(TraceRecordSchema.safeParse(document).success).toBe(true);
  });

  caseTest("extension-value-ajv-runtime-parity-pass", async () => {
    const document = documentWithExtension(["alpha", ["beta"], { "network.jinn.note": "nested" }]);
    expect(await ajvAccepts(document)).toBe(true);
    expect(() => preflightCanonicalInput(document)).not.toThrow();
    expect(TraceRecordSchema.safeParse(document).success).toBe(true);
  });

  caseTest("extension-value-array-sparse-fails", () => {
    const sparse: unknown[] = [];
    sparse[1] = "alpha";
    expect(() => preflightCanonicalInput(documentWithExtension(sparse))).toThrow();
  });

  caseTest("extension-value-array-subclass-fails", () => {
    class SubArray extends Array {}
    const hostile: string[] = ["alpha"];
    Object.setPrototypeOf(hostile, SubArray.prototype);
    expect(() => preflightCanonicalInput(documentWithExtension(hostile))).toThrow();
  });

  caseTest("extension-value-array-proxy-fails", () => {
    const { proxy, revoke } = Proxy.revocable(["alpha"], {});
    revoke();
    expect(() => preflightCanonicalInput(documentWithExtension(proxy))).toThrow();
  });

  caseTest("extension-value-array-cycle-fails", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => preflightCanonicalInput(documentWithExtension(cyclic))).toThrow(
      UnsupportedCanonicalValueError,
    );
  });

  caseTest("extension-value-array-unsafe-number-fails", () => {
    expect(() => preflightCanonicalInput(documentWithExtension([Number.MAX_SAFE_INTEGER + 1]))).toThrow();
  });

  caseTest("extension-value-non-namespaced-object-fails", () => {
    expect(() => preflightCanonicalInput(documentWithExtension([{ plain: "bad" }]))).toThrow();
  });

  caseTest("extension-value-seal-parse-roundtrip-pass", async () => {
    const base = (await loadGoldenJson("valid")) as Record<string, unknown>;
    const source = base["source"] as Record<string, unknown>;
    const nativeTrace = source["nativeTrace"] as Record<string, unknown>;
    const document = {
      ...base,
      source: {
        ...source,
        nativeTrace: {
          ...nativeTrace,
          "network.jinn.tags": ["alpha", ["beta"], { "network.jinn.note": "kept" }],
        },
      },
    };
    expect(await ajvAccepts(document)).toBe(true);
    const sealed = sealTrace(document);
    const parsed = parseTrace(sealed.bytes);
    expect((parsed.source.nativeTrace as Record<string, unknown>)["network.jinn.tags"]).toEqual([
      "alpha",
      ["beta"],
      { "network.jinn.note": "kept" },
    ]);
    const twice = sealTrace(parsed);
    expect(twice.bytes).toEqual(sealed.bytes);
  });

  caseTest("sha256Hex-current-realm-sab-rejects", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    expect(() => sha256Hex(new Uint8Array(new SharedArrayBuffer(8)))).toThrow(TypeError);
  });

  caseTest("sha256Hex-vm-realm-sab-rejects", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const otherSab = vm.runInNewContext("new SharedArrayBuffer(8)") as SharedArrayBuffer;
    expect(() => sha256Hex(new Uint8Array(otherSab))).toThrow(TypeError);
  });

  caseTest("snapshotByteView-vm-realm-sab-rejects", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const otherSab = vm.runInNewContext("new SharedArrayBuffer(8)") as SharedArrayBuffer;
    expect(() => snapshotByteView(new Uint8Array(otherSab), "view")).toThrow(/SharedArrayBuffer/);
  });

  caseTest("parse-trace-vm-realm-sab-rejects", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const sealed = sealTrace(documentWithExtension(["alpha"]));
    const otherSab = vm.runInNewContext("new SharedArrayBuffer(8)") as SharedArrayBuffer;
    const hostile = new Uint8Array(otherSab);
    Object.defineProperty(hostile, "0", { value: sealed.bytes[0], enumerable: true, configurable: true });
    expect(() => parseTrace(hostile)).toThrow(TypeError);
  });
}
