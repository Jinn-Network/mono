// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import type { DsseSigner } from "@jinn-network/trust-core";

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
import {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  verifyTrajectoryDerivationAttestation,
} from "./derivation.js";
import { documentDigest } from "./hashing.js";
import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["valid", "minimal"];

const kitSigner: DsseSigner = async () => [
  { signature: new Uint8Array([9, 8, 7]), keyid: "kit-key" },
];

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

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(4);
      for (const entry of manifest.fixtures) {
        const document = await readAdversarialJson(entry.id, "document.json");
        const accepted = TrajectoryRecordSchema.safeParse(document).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });

    test("derivation attestation: malformed envelope fails L1 without calling authority", async () => {
      const verifyAuthority = vi.fn();
      const result = await verifyTrajectoryDerivationAttestation({
        envelopeBytes: new TextEncoder().encode("not-json"),
        executionRecordBytes: new Uint8Array(),
        trajectoryRecordBytes: new Uint8Array(),
        verifyAuthority,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failedLayer).toBe(1);
      expect(verifyAuthority).not.toHaveBeenCalled();
    });

    test("derivation attestation: valid chain passes L1-L3; L4 is replay-required", async () => {
      const record = await loadGoldenJson("valid");
      const trajectorySealed = sealTrajectory(record);
      const trajectoryDigest = trajectorySealed.digest;
      const nativeSha = (record as { source: { nativeTrace: { digest: { sha256: string } } } })
        .source.nativeTrace.digest.sha256;
      const executionBytes = new TextEncoder().encode(
        JSON.stringify({
          "@context": "https://w3id.org/ro/crate/1.3/context",
          "@graph": [
            {
              "@id": "trace/native.bin",
              "@type": "File",
              sha256: nativeSha,
              identifier: {
                "@type": "PropertyValue",
                propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
                value: trajectoryDigest,
              },
            },
          ],
        }),
      );
      const statement = buildTrajectoryDerivationStatement({
        producerId: "kit-producer",
        executionDigest: documentDigest(executionBytes),
        trajectoryDigest,
        nativeTraceDigest: `sha256:${nativeSha}`,
        formatIri: (record as { source: { formatIri: string } }).source.formatIri,
        decoderId: (record as { derivation: { decoderId: string } }).derivation.decoderId,
        decoderVersion: (record as { derivation: { decoderVersion: string } }).derivation.decoderVersion,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
        timebase: (record as { timebase: "source-epoch-ns" | "synthetic-ordinal" }).timebase,
        derivedAt: "2026-07-31T12:00:00Z",
      });
      const sealed = await sealTrajectoryDerivationAttestation({
        statement,
        signer: kitSigner,
      });
      const result = await verifyTrajectoryDerivationAttestation({
        envelopeBytes: sealed.envelopeBytes,
        executionRecordBytes: executionBytes,
        trajectoryRecordBytes: trajectorySealed.bytes,
        verifyAuthority: async () => ({ verified: true, signerKeyIds: ["kit-key"] }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers.l4).toEqual({ status: "not-evaluated", reason: "replay-required" });
      }
    });
  });
}
