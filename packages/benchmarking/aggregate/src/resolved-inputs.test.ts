import {
  canonicalJsonBytes,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { sealTask } from "@jinn-network/task-execution-protocol";
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

function task(provenance: Record<string, unknown>): Uint8Array {
  return sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: { digest: { sha256: "b".repeat(64) } }, instructions: "fixture", outputs: [],
    evaluation: { digest: { sha256: "c".repeat(64) } }, payload: { provenance },
  });
}

function validStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "fixture", digest: { sha256: "a".repeat(64) } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
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

function issuerStatementBytes(value: unknown): Uint8Array {
  const sort = (candidate: unknown): unknown => Array.isArray(candidate)
    ? candidate.map(sort)
    : typeof candidate === "object" && candidate !== null
      ? Object.fromEntries(Object.entries(candidate).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0).map(([key, nested]) => [key, sort(nested)]))
      : candidate;
  return new TextEncoder().encode(`${JSON.stringify(sort(value), null, 2)}\n`);
}

describe("exact referenced Verdict bytes", () => {
  test("validates the minimal frozen Result Evaluation identity/outcome/time fields", () => {
    const bytes = envelope(canonicalJsonBytes(validStatement()));
    const digest = recordDigest(bytes);
    expect(resolveVerdictOutcome(digest, {
      resolveVerdictBytes: (requested) => requested === digest ? bytes : undefined,
    })).toEqual({ verdict: "pass" });
  });

  test("accepts the evidence issuer's exact deterministic Result Evaluation spelling", () => {
    const bytes = envelope(issuerStatementBytes(validStatement()));
    const digest = recordDigest(bytes);
    expect(resolveVerdictOutcome(digest, {
      resolveVerdictBytes: (requested) => requested === digest ? bytes : undefined,
    })).toEqual({ verdict: "pass" });
  });

  test("rejects a Result Evaluation with an impossible civil evaluatedAt date", () => {
    const statement = validStatement();
    (statement["predicate"] as Record<string, unknown>)["evaluatedAt"] = "2026-02-30T00:00:00Z";
    const bytes = envelope(canonicalJsonBytes(statement));
    const digest = recordDigest(bytes);
    expect(() => resolveVerdictOutcome(digest, {
      resolveVerdictBytes: () => bytes,
    })).toThrow(expect.objectContaining({
      code: "verdict-record-malformed",
      digest,
    }));
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
    const bytes = task({ source: "repository/\u{1f680}", timestamp: "2026-07-29T00:00:00Z" });
    const digest = recordDigest(bytes);
    expect(resolveTaskProvenance(digest.slice("sha256:".length), {
      resolveTaskBytes: () => bytes,
    })).toEqual({
      timestamp: "2026-07-29T00:00:00Z",
      cluster: { tag: "source", value: "repository/\u{1f680}" },
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

  test("uses a tagged plaintext-or-commitment source-family key and rejects ambiguous provenance", () => {
    const commitment = `sha256:${"c".repeat(64)}`;
    const committed = task({ timestamp: "2026-07-29T00:00:00Z", sourceCommitment: commitment });
    const digest = recordDigest(committed);
    expect(resolveTaskProvenance(digest.slice("sha256:".length), { resolveTaskBytes: () => committed }))
      .toEqual({ timestamp: "2026-07-29T00:00:00Z", cluster: { tag: "sourceCommitment", value: commitment } });

    const ambiguous = task({ timestamp: "2026-07-29T00:00:00Z", source: "sha256:source", sourceCommitment: commitment });
    const ambiguousDigest = recordDigest(ambiguous);
    expect(() => resolveTaskProvenance(ambiguousDigest.slice("sha256:".length), { resolveTaskBytes: () => ambiguous }))
      .toThrow(expect.objectContaining({ code: "task-provenance-source-missing" }));
  });

  test("rejects an impossible civil Task provenance timestamp", () => {
    const bytes = task({ source: "fixture", timestamp: "2026-02-30T00:00:00Z" });
    const digest = recordDigest(bytes);
    expect(() => resolveTaskProvenance(digest.slice("sha256:".length), {
      resolveTaskBytes: () => bytes,
    })).toThrow(expect.objectContaining({
      code: "task-provenance-source-missing",
      digest,
    }));
  });
});

describe("authenticated anchored announcement evidence", () => {
  const benchmarkDigest = `sha256:${"d".repeat(64)}`;
  const source = {
    agent: "urn:uuid:88888888-8888-5888-8888-888888888888",
    name: "fixture",
  };

  function entryBytes(overrides: Record<string, unknown> = {}): Uint8Array {
    return canonicalJsonBytes({
      protocol: "https://spec.jinn.network/record-discovery/v1",
      source,
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-28T23:59:59Z",
      announcements: [{
        announcementId: "fixture-benchmark",
        action: "available",
        record: {
          kind: "https://spec.jinn.network/records/benchmark/v1",
          digest: benchmarkDigest,
        },
      }],
      ...overrides,
    });
  }

  function signedEntry(
    payloadBytes: Uint8Array,
    signature: Uint8Array = Uint8Array.of(1),
    payloadType = "application/vnd.jinn.discovery.entry.v1+json",
  ): Uint8Array {
    return sealDsseEnvelope({
      payloadBytes,
      payloadType,
      signatures: [{ keyid: "did:key:zFixture", signature }],
    });
  }

  test("derives time from proof-bearing verification of exact signature, source, chain, and anchor", () => {
    const payloadBytes = entryBytes();
    const envelopeBytes = signedEntry(payloadBytes);
    const entryDigest = recordDigest(payloadBytes);
    expect(resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      (request) => {
        expect(request).toMatchObject({
          benchmarkDigest,
          entryDigest,
          source,
          sequence: "0000000000000001",
          previous: null,
          entryTimestamp: "2026-07-28T23:59:59Z",
        });
        expect(request.envelopeBytes).toEqual(envelopeBytes);
        expect(request.entryBytes).toEqual(payloadBytes);
        return {
          ok: true,
          source,
          verifiedEntryDigests: [entryDigest],
          headDigest: entryDigest,
          anchor: {
            digest: entryDigest,
            anchorTime: "2026-07-29T00:00:00Z",
          },
        };
      },
    )).toBe("2026-07-29T00:00:00Z");
  });

  test.each([
    ["signature", signedEntry(entryBytes(), Uint8Array.of(9))],
    ["source binding", signedEntry(entryBytes({
      source: { ...source, agent: "urn:uuid:99999999-9999-5999-8999-999999999999" },
    }))],
    ["chain link", signedEntry(entryBytes({
      sequence: "0000000000000002",
      previous: `sha256:${"0".repeat(64)}`,
    }))],
  ])("fails closed when injected verification rejects a forged %s", (_name, envelopeBytes) => {
    expect(() => resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => ({ ok: false, reason: "discovery verification rejected forged evidence" }),
    )).toThrow(expect.objectContaining({
      code: "anchored-announcement-unverified",
      digest: benchmarkDigest,
    }));
  });

  test("rejects a forged digest announcement before trusting the verification port", () => {
    const envelopeBytes = signedEntry(entryBytes({
      announcements: [{
        announcementId: "fixture-benchmark",
        action: "available",
        record: {
          kind: "https://spec.jinn.network/records/benchmark/v1",
          digest: `sha256:${"e".repeat(64)}`,
        },
      }],
    }));
    expect(() => resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => { throw new Error("must not verify a payload that does not name the Benchmark"); },
    )).toThrow(expect.objectContaining({
      code: "anchored-announcement-malformed",
      digest: benchmarkDigest,
    }));
  });

  test("rejects invalid or mismatched verifier-derived chain/anchor facts and times", () => {
    const payloadBytes = entryBytes();
    const envelopeBytes = signedEntry(payloadBytes);
    const entryDigest = recordDigest(payloadBytes);
    for (const proof of [
      {
        ok: true as const,
        source,
        verifiedEntryDigests: [entryDigest],
        headDigest: entryDigest,
        anchor: { digest: entryDigest, anchorTime: "forged-time" },
      },
      {
        ok: true as const,
        source,
        verifiedEntryDigests: [entryDigest],
        headDigest: entryDigest,
        anchor: { digest: entryDigest, anchorTime: "2026-02-30T00:00:00Z" },
      },
      {
        ok: true as const,
        source,
        verifiedEntryDigests: [`sha256:${"a".repeat(64)}`],
        headDigest: `sha256:${"a".repeat(64)}`,
        anchor: { digest: `sha256:${"a".repeat(64)}`, anchorTime: "2026-07-29T00:00:00Z" },
      },
      {
        ok: true as const,
        source: { ...source, name: "other" },
        verifiedEntryDigests: [entryDigest],
        headDigest: entryDigest,
        anchor: { digest: entryDigest, anchorTime: "2026-07-29T00:00:00Z" },
      },
    ]) {
      expect(() => resolveAnchoredAnnouncementTime(
        benchmarkDigest,
        envelopeBytes,
        () => proof,
      )).toThrow(expect.objectContaining({
        code: "anchored-announcement-unverified",
        digest: benchmarkDigest,
      }));
    }
  });

  test("rejects an anchor that precedes the signed entry by a sub-millisecond fraction", () => {
    const payloadBytes = entryBytes({
      timestamp: "2026-07-29T00:00:00.0002Z",
    });
    const envelopeBytes = signedEntry(payloadBytes);
    const entryDigest = recordDigest(payloadBytes);
    expect(() => resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => ({
        ok: true,
        source,
        verifiedEntryDigests: [entryDigest],
        headDigest: entryDigest,
        anchor: {
          digest: entryDigest,
          anchorTime: "2026-07-29T00:00:00.0001Z",
        },
      }),
    )).toThrow(expect.objectContaining({
      code: "anchored-announcement-unverified",
      digest: benchmarkDigest,
    }));
  });

  test("accepts an anchor at the same instant expressed under a different offset", () => {
    const payloadBytes = entryBytes({
      timestamp: "2026-07-29T00:00:00.1234Z",
    });
    const envelopeBytes = signedEntry(payloadBytes);
    const entryDigest = recordDigest(payloadBytes);
    expect(resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => ({
        ok: true,
        source,
        verifiedEntryDigests: [entryDigest],
        headDigest: entryDigest,
        anchor: {
          digest: entryDigest,
          anchorTime: "2026-07-29T02:30:00.123400+02:30",
        },
      }),
    )).toBe("2026-07-29T02:30:00.123400+02:30");
  });

  test("rejects an impossible civil signed entry timestamp before invoking verification", () => {
    const envelopeBytes = signedEntry(entryBytes({
      timestamp: "2026-02-30T00:00:00Z",
    }));
    expect(() => resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => { throw new Error("must not verify a calendar-invalid entry"); },
    )).toThrow(expect.objectContaining({
      code: "anchored-announcement-malformed",
      digest: benchmarkDigest,
    }));
  });

  test("rejects a signed payload under the wrong DSSE media type", () => {
    const envelopeBytes = signedEntry(entryBytes(), Uint8Array.of(1), "application/json");
    expect(() => resolveAnchoredAnnouncementTime(
      benchmarkDigest,
      envelopeBytes,
      () => ({ ok: false, reason: "not reached" }),
    )).toThrow(expect.objectContaining({
      code: "anchored-announcement-malformed",
      digest: benchmarkDigest,
    }));
  });
});
