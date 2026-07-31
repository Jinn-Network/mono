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
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["valid", "minimal"];

/**
 * Record conformance for the Trajectory kind: schema validation, producer-side re-seal,
 * consumer-side digest verification without re-canonicalization, derived-identity
 * recomputation, derivation attestation layers L1–L4, and the adversarial corpus.
 */
export function describeTrajectoryRecordConformance(): void {
  describe("Trajectory record conformance", () => {
    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(TrajectoryRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const pinnedBytes = await loadGoldenBytes(name);
        const pinnedDigest = await loadGoldenDigest(name);
        const resealed = sealTrajectory(await loadGoldenJson(name));
        expect(new TextDecoder().decode(resealed.bytes)).toBe(
          new TextDecoder().decode(pinnedBytes),
        );
        expect(resealed.digest).toBe(pinnedDigest);
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(documentDigest(await loadGoldenBytes(name))).toBe(await loadGoldenDigest(name));
      });

      test("every identifier recomputes from the record's own declared inputs", async () => {
        const record = parseTrajectory(await loadGoldenBytes(name));
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
        const once = sealTrajectory(await loadGoldenJson(name));
        const twice = sealTrajectory(parseTrajectory(once.bytes));
        expect(twice.digest).toBe(once.digest);
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      expect(sealTrajectory(await loadEquivalenceInput("a")).digest).toBe(expected);
      expect(sealTrajectory(await loadEquivalenceInput("b")).digest).toBe(expected);
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const record = await loadGoldenJson("valid");
      const nonCanonical = new TextEncoder().encode(JSON.stringify(record, null, 2));
      expect(() => parseTrajectory(nonCanonical)).toThrow();
    });

    test("tail-truncated golden bytes fail parse", async () => {
      const bytes = await loadGoldenBytes("valid");
      expect(() => parseTrajectory(bytes.subarray(0, bytes.length - 4))).toThrow();
    });

    test("appended golden bytes fail parse", async () => {
      const bytes = await loadGoldenBytes("valid");
      const appended = new Uint8Array(bytes.length + 3);
      appended.set(bytes);
      appended.set(new TextEncoder().encode("xxx"), bytes.length);
      expect(() => parseTrajectory(appended)).toThrow();
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
      expect(TrajectoryRecordSchema.safeParse(fabricated).success).toBe(false);
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(8);
      for (const entry of manifest.fixtures) {
        const document = await readAdversarialJson(entry.id, "document.json");
        const accepted = TrajectoryRecordSchema.safeParse(document).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });

    test("namespaced extension round-trips through seal and parse", async () => {
      const document = await readAdversarialJson("namespaced-extension-preserved", "document.json");
      const sealed = sealTrajectory(document);
      const parsed = parseTrajectory(sealed.bytes);
      expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
      expect(sealTrajectory(parsed).digest).toBe(sealed.digest);
    });
  });
}

export { describeTrajectoryDerivationAttestationConformance } from "./derivation-conformance.js";
