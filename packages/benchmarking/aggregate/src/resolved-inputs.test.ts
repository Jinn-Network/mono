import {
  canonicalJsonBytes,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import {
  MethodInputError,
  resolveAnchoredAnnouncementTime,
  resolveTaskProvenance,
  resolveVerdictOutcome,
} from "./resolved-inputs.js";

function envelope(payloadBytes: Uint8Array): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zFixture", signature: Uint8Array.of(1) }],
  });
}

function validStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "fixture", digest: { sha256: "a".repeat(64) } }],
    predicateType: "https://jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-07-29T00:00:00Z",
      evaluator: { id: "urn:uuid:77777777-7777-5777-8777-777777777777" },
      taskSubject: "execution/task/task.json",
      resultSubjects: ["execution/result/result.json"],
      verdict: "pass",
    },
    ...overrides,
  };
}

describe("exact referenced Verdict bytes", () => {
  test("validates the minimal frozen Result Evaluation identity/outcome/time fields", () => {
    const bytes = envelope(canonicalJsonBytes(validStatement()));
    const digest = recordDigest(bytes);
    expect(resolveVerdictOutcome(digest, {
      resolveVerdictBytes: (requested) => requested === digest ? bytes : undefined,
    })).toEqual({ verdict: "pass" });
  });

  test("names unavailable, digest-mismatched, and malformed exact references", () => {
    const missing = `sha256:${"b".repeat(64)}`;
    expect(() => resolveVerdictOutcome(missing, { resolveVerdictBytes: () => undefined }))
      .toThrow(expect.objectContaining({
        code: "verdict-record-unavailable",
        digest: missing,
      }));

    const malformed = envelope(canonicalJsonBytes({ predicate: { verdict: "pass" } }));
    const malformedDigest = recordDigest(malformed);
    expect(() => resolveVerdictOutcome(malformedDigest, {
      resolveVerdictBytes: () => malformed,
    })).toThrow(expect.objectContaining({
      code: "verdict-record-malformed",
      digest: malformedDigest,
    }));

    expect(() => resolveVerdictOutcome(missing, {
      resolveVerdictBytes: () => malformed,
    })).toThrow(expect.objectContaining({
      code: "verdict-record-digest-mismatch",
      digest: missing,
    }));
  });

  test("rejects lone surrogates recursively and accepts a valid supplementary scalar", () => {
    const supplementary = envelope(canonicalJsonBytes(validStatement({
      "fixture/note": "rocket \u{1f680}",
    })));
    const supplementaryDigest = recordDigest(supplementary);
    expect(() => resolveVerdictOutcome(supplementaryDigest, {
      resolveVerdictBytes: () => supplementary,
    })).not.toThrow();

    const lonePayload = new TextEncoder().encode(
      JSON.stringify(validStatement()).replace('"pass"', '"\\ud800"'),
    );
    const lone = envelope(lonePayload);
    const loneDigest = recordDigest(lone);
    expect(() => resolveVerdictOutcome(loneDigest, {
      resolveVerdictBytes: () => lone,
    })).toThrow(expect.objectContaining({ code: "verdict-record-malformed" }));
  });
});

describe("exact Task provenance bytes", () => {
  test("binds digest and accepts valid supplementary provenance strings", () => {
    const bytes = canonicalJsonBytes({
      payload: {
        provenance: {
          source: "repository/\u{1f680}",
          timestamp: "2026-07-29T00:00:00Z",
        },
      },
    });
    const digest = recordDigest(bytes);
    expect(resolveTaskProvenance(digest.slice("sha256:".length), {
      resolveTaskBytes: () => bytes,
    })).toEqual({
      source: "repository/\u{1f680}",
      timestamp: "2026-07-29T00:00:00Z",
    });
  });

  test("rejects lone surrogates before provenance computation", () => {
    const bytes = new TextEncoder().encode(
      '{"payload":{"provenance":{"source":"\\ud800","timestamp":"2026-07-29T00:00:00Z"}}}',
    );
    const digest = recordDigest(bytes);
    expect(() => resolveTaskProvenance(digest.slice("sha256:".length), {
      resolveTaskBytes: () => bytes,
    })).toThrow(MethodInputError);
  });
});

describe("authenticated anchored announcement evidence", () => {
  const benchmarkDigest = `sha256:${"d".repeat(64)}`;
  const entryBytes = canonicalJsonBytes({
    protocol: "https://jinn.network/record-discovery/1.0",
    announcements: [{
      action: "available",
      record: {
        kind: "https://jinn.network/records/benchmark/1.0",
        digest: benchmarkDigest,
      },
    }],
  });

  test("accepts exact signed Discovery Entry bytes naming the requested Benchmark", () => {
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes: entryBytes,
      payloadType: "application/vnd.jinn.discovery.entry.v1+json",
      signatures: [{ keyid: "did:key:zFixture", signature: Uint8Array.of(1) }],
    });
    expect(resolveAnchoredAnnouncementTime(benchmarkDigest, {
      envelopeBytes,
      entryBytes,
      anchoredAt: "2026-07-29T00:00:00Z",
      verification: "verified",
    })).toBe("2026-07-29T00:00:00Z");
  });

  test("fails closed when a resolver returns an unverified marker", () => {
    const proof = {
      envelopeBytes: new Uint8Array(),
      entryBytes: new Uint8Array(),
      anchoredAt: "2026-07-29T00:00:00Z",
      verification: "unverified",
    } as unknown as Parameters<typeof resolveAnchoredAnnouncementTime>[1];

    expect(() => resolveAnchoredAnnouncementTime(benchmarkDigest, proof)).toThrow(
      expect.objectContaining({
        code: "anchored-announcement-unverified",
        digest: benchmarkDigest,
      }),
    );
  });

  test("rejects a signed payload under the wrong DSSE media type", () => {
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes: entryBytes,
      payloadType: "application/json",
      signatures: [{ keyid: "did:key:zFixture", signature: Uint8Array.of(1) }],
    });
    expect(() => resolveAnchoredAnnouncementTime(benchmarkDigest, {
      envelopeBytes,
      entryBytes,
      anchoredAt: "2026-07-29T00:00:00Z",
      verification: "verified",
    })).toThrow(expect.objectContaining({
      code: "anchored-announcement-malformed",
      digest: benchmarkDigest,
    }));
  });
});
