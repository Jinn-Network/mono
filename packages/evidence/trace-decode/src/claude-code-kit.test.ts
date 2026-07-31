import { describe, expect, test } from "vitest";

import {
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveSpanId,
  deriveTraceId,
  parseTrajectory,
  sealTrajectory,
  sha256Hex,
} from "@jinn-network/evidence-trajectory";

import { createClaudeCodeStreamJsonDecoder } from "./claude-code-stream-json.js";
import { decodeTrajectory } from "./decode.js";
import { loadClaudeCodeFixtures, loadDecoderFixtureManifest } from "./fixtures.js";
import { createDecoderRegistry } from "./registry.js";
import { describeTraceDecoderContract } from "./testing.js";

describeTraceDecoderContract("claude-code-stream-json", async () => ({
  decoder: createClaudeCodeStreamJsonDecoder(),
  fixtures: await loadClaudeCodeFixtures(),
}));

describe("claude-code-stream-json fixture corpus", () => {
  test("the manifest pins the decoder identity the corpus was generated with", async () => {
    const manifest = await loadDecoderFixtureManifest();
    const decoder = createClaudeCodeStreamJsonDecoder();
    expect(manifest.formatIri).toBe(decoder.formatIri);
    expect(manifest.decoderId).toBe(decoder.decoderId);
    expect(manifest.decoderVersion).toBe(decoder.decoderVersion);
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(8);
  });

  test("the corpus covers full, partial, and empty decodes", async () => {
    const fixtures = await loadClaudeCodeFixtures();
    expect(
      new Set(fixtures.map((fixture) => fixture.expected.completeness.decoded)),
    ).toEqual(new Set(["full", "partial", "empty"]));
  });

  test("every case pins a record digest", async () => {
    for (const fixture of await loadClaudeCodeFixtures()) {
      expect(fixture.expected.recordDigest, fixture.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("adversarial cases carry none of their injected content into any span", async () => {
    const manifest = await loadDecoderFixtureManifest();
    const fixtures = await loadClaudeCodeFixtures();
    const adversarial = manifest.fixtures.filter(
      (entry) => entry.mustNotContain !== undefined,
    );
    expect(adversarial.length).toBeGreaterThanOrEqual(1);
    for (const entry of adversarial) {
      const fixture = fixtures.find((candidate) => candidate.id === entry.id);
      expect(fixture, entry.id).toBeDefined();
      expect(new TextDecoder().decode(fixture!.bytes)).toContain(entry.mustNotContain!);
      expect(JSON.stringify(fixture!.expected.spans), entry.id).not.toContain(
        entry.mustNotContain!,
      );
    }
  });
});

describe("end-to-end: bytes to a sealed record", () => {
  test("a decoded trace seals to a record whose every identifier recomputes", async () => {
    const decoder = createClaudeCodeStreamJsonDecoder();
    const registry = createDecoderRegistry([decoder]);
    const fixtures = await loadClaudeCodeFixtures();
    const fixture = fixtures.find((candidate) => candidate.id === "tool-loop");
    expect(fixture).toBeDefined();

    const document = decodeTrajectory(registry, decoder.formatIri, {
      bytes: fixture!.bytes,
      nativeTrace: {
        name: "stdout.jsonl",
        mediaType: "application/x-ndjson",
        digest: { sha256: sha256Hex(fixture!.bytes) },
      },
    });

    const sealed = sealTrajectory(document);
    expect(sealed.digest).toBe(fixture!.expected.recordDigest);

    const record = parseTrajectory(sealed.bytes);
    expect(record.traceId).toBe(
      deriveTraceId({
        sourceDigest: `sha256:${record.source.nativeTrace.digest.sha256}`,
        formatIri: record.source.formatIri,
        decoderId: record.derivation.decoderId,
        decoderVersion: record.derivation.decoderVersion,
        vocabularyProfile: record.derivation.vocabularyProfile,
      }),
    );
    expect(record.derivation.vocabularyProfile).toBe(TRAJECTORY_VOCABULARY_PROFILE);
    expect(record.timebase).toBe("synthetic-ordinal");
    record.spans.forEach((span, ordinal) => {
      expect(span.spanId).toBe(deriveSpanId(record.traceId, ordinal));
    });
    expect(record.spans.length).toBeGreaterThan(1);
  });
});
