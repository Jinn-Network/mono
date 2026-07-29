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
  const source = {
    agent: "urn:uuid:88888888-8888-5888-8888-888888888888",
    name: "fixture",
  };

  function entryBytes(overrides: Record<string, unknown> = {}): Uint8Array {
    return canonicalJsonBytes({
      protocol: "https://jinn.network/record-discovery/1.0",
      source,
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-28T23:59:59Z",
      announcements: [{
        announcementId: "fixture-benchmark",
        action: "available",
        record: {
          kind: "https://jinn.network/records/benchmark/1.0",
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
          kind: "https://jinn.network/records/benchmark/1.0",
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
