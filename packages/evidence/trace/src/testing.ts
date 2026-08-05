// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  type GoldenName,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  readAdversarialJson,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { InvalidDocumentError } from "./sealing.js";
import { TraceRecordSchema, parseTrace, sealTrace } from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["valid", "minimal"];

/**
 * Record conformance for the Trace kind: schema validation, producer-side re-seal,
 * consumer-side digest verification without re-canonicalization, derived-identity
 * recomputation, derivation attestation layers L1–L4, and the adversarial corpus.
 */
export function describeTraceRecordConformance(): void {
  describe("Trace record conformance", () => {
    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(TraceRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const pinnedBytes = await loadGoldenBytes(name);
        const pinnedDigest = await loadGoldenDigest(name);
        const resealed = sealTrace(await loadGoldenJson(name));
        expect(new TextDecoder().decode(resealed.bytes)).toBe(
          new TextDecoder().decode(pinnedBytes),
        );
        expect(resealed.digest).toBe(pinnedDigest);
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(documentDigest(await loadGoldenBytes(name))).toBe(await loadGoldenDigest(name));
      });

      test("every identifier recomputes from the record's own declared inputs", async () => {
        const record = parseTrace(await loadGoldenBytes(name));
        expect(record.traceId).toBe(
          deriveTraceId({
            sourceDigest: `sha256:${record.source.nativeTrace.digest.sha256}`,
            formatIri: record.source.formatIri,
            decoderId: record.derivation.decoderId,
            decoderVersion: record.derivation.decoderVersion,
            vocabularyProfile: record.derivation.vocabularyProfile,
          }),
        );
        record.spans.forEach((span, ordinal) => {
          expect(span.spanId).toBe(deriveSpanId(record.traceId, ordinal));
        });
      });

      test("sealing is idempotent", async () => {
        const once = sealTrace(await loadGoldenJson(name));
        const twice = sealTrace(parseTrace(once.bytes));
        expect(twice.digest).toBe(once.digest);
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      expect(sealTrace(await loadEquivalenceInput("a")).digest).toBe(expected);
      expect(sealTrace(await loadEquivalenceInput("b")).digest).toBe(expected);
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const record = await loadGoldenJson("valid");
      const nonCanonical = new TextEncoder().encode(JSON.stringify(record, null, 2));
      expect(() => parseTrace(nonCanonical)).toThrow();
    });

    test("UTF-8 BOM prefix is rejected at parse", async () => {
      const bytes = await loadGoldenBytes("valid");
      const bomPrefixed = new Uint8Array(bytes.length + 3);
      bomPrefixed.set([0xef, 0xbb, 0xbf], 0);
      bomPrefixed.set(bytes, 3);
      expect(() => parseTrace(bomPrefixed)).toThrow(InvalidDocumentError);
    });

    test("invalid UTF-8 bytes are rejected at parse", () => {
      expect(() => parseTrace(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(
        InvalidDocumentError,
      );
    });

    test("tail-truncated golden bytes fail parse", async () => {
      const bytes = await loadGoldenBytes("valid");
      expect(() => parseTrace(bytes.subarray(0, bytes.length - 4))).toThrow();
    });

    test("appended golden bytes fail parse", async () => {
      const bytes = await loadGoldenBytes("valid");
      const appended = new Uint8Array(bytes.length + 3);
      appended.set(bytes);
      appended.set(new TextEncoder().encode("xxx"), bytes.length);
      expect(() => parseTrace(appended)).toThrow();
    });

    test("whole-list span fabrication fails schema validation", async () => {
      const record = (await loadGoldenJson("valid")) as Record<string, unknown>;
      const fabricated = {
        ...record,
        spans: [
          {
            spanId: "f".repeat(16),
            parentSpanId: null,
            name: "fabricated",
            kind: 1,
            startTimeUnixNano: "0",
            endTimeUnixNano: "1",
            attributes: [],
            events: [],
            status: { code: 1 },
          },
        ],
      };
      expect(TraceRecordSchema.safeParse(fabricated).success).toBe(false);
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(8);
      for (const entry of manifest.fixtures) {
        const document = await readAdversarialJson(entry.id, "document.json");
        const accepted = TraceRecordSchema.safeParse(document).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });

    test("namespaced extension round-trips through seal and parse", async () => {
      const document = await readAdversarialJson("namespaced-extension-preserved", "document.json");
      const sealed = sealTrace(document);
      const parsed = parseTrace(sealed.bytes);
      expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
      expect(sealTrace(parsed).digest).toBe(sealed.digest);
    });
  });
}

export { describeTraceDerivationAttestationConformance } from "./derivation-conformance.js";
export {
  TRACE_DERIVATION_CONFORMANCE_CASE_COUNT,
  TRACE_DERIVATION_CONFORMANCE_CASE_IDS,
} from "./conformance-case-manifest.js";
export type { TraceDerivationConformanceCaseId } from "./conformance-case-manifest.js";
