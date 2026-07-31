// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import { EnvironmentVerificationError } from "./errors.js";
import {
  attestationMatchesRecord,
  buildEnvironmentVerificationStatement,
  verifyBaselineCounts,
} from "./statement.js";
import { buildEnvironmentVerificationSubjects } from "./subject.js";
import type { EnvironmentVerificationPredicate } from "./predicate.js";

const RECORD_HEX = "1".repeat(64);
const IMAGE_HEX = "2".repeat(64);

const OUTCOMES: OutcomeSet = {
  "tests/test_a.py::test_one": "pass",
  "tests/test_b.py::test_two": "fail",
};

function predicateFor(outcomeSetDigestValue: `sha256:${string}`): EnvironmentVerificationPredicate {
  return {
    protocol: "https://jinn.network/environment-verification/protocol/1.0",
    result: "stable",
    window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:25:00.000Z" },
    runs: {
      count: 5,
      outcomeSetDigest: outcomeSetDigestValue,
      perRun: Array.from({ length: 5 }, () => ({
        outcomeSetDigest: outcomeSetDigestValue,
        wallSeconds: 12,
      })),
    },
    baseline: {
      passing: 1,
      failing: 1,
      skipped: 0,
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigestValue.slice("sha256:".length) },
      },
    },
    controls: {
      network: "none",
      seeds: { PYTHONHASHSEED: "0" },
      order: "default",
      parallelism: 1,
      locale: "C.UTF-8",
      tz: "UTC",
    },
    runtime: { minSeconds: 11, maxSeconds: 13, timeoutSeconds: 1800 },
    verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: `sha256:${IMAGE_HEX}` },
  } as EnvironmentVerificationPredicate;
}

describe("subjects and statement", () => {
  it("emits bare-hex DigestSet values in a fixed [environment, image] order", () => {
    expect(buildEnvironmentVerificationSubjects({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
    })).toEqual([
      { name: "environment", digest: { sha256: RECORD_HEX } },
      { name: "image", digest: { sha256: IMAGE_HEX } },
    ]);
  });

  it("refuses a prefixed DigestSet value at the subject boundary", () => {
    expect(() => buildEnvironmentVerificationSubjects({
      recordDigest: RECORD_HEX as `sha256:${string}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
    })).toThrow(EnvironmentVerificationError);
  });

  it("builds a schema-valid in-toto Statement", () => {
    const digest = `sha256:${"3".repeat(64)}` as const;
    const statement = buildEnvironmentVerificationStatement({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
      predicate: predicateFor(digest),
    });
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType)
      .toBe("https://jinn.network/attestations/environment-verification/v1");
    expect(statement.subject).toHaveLength(2);
  });

  it("matches on the environment subject only, never any-subject", () => {
    const digest = `sha256:${"3".repeat(64)}` as const;
    const statement = buildEnvironmentVerificationStatement({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
      predicate: predicateFor(digest),
    });
    expect(attestationMatchesRecord(statement, `sha256:${RECORD_HEX}`)).toBe(true);
    // The image subject matches, the environment subject does not: a narrow-scope
    // attestation must NOT extend to a different record (design §5.1).
    expect(attestationMatchesRecord(statement, `sha256:${IMAGE_HEX}`)).toBe(false);
  });

  it("catches re-signed payloads whose baseline counts were altered", () => {
    const bytes = canonicalOutcomeSetBytes(OUTCOMES);
    const digest = outcomeSetDigest(OUTCOMES);
    const honest = predicateFor(digest);
    expect(verifyBaselineCounts(honest, bytes)).toBe(true);

    const tampered = {
      ...honest,
      baseline: { ...honest.baseline!, passing: 999 },
    } as EnvironmentVerificationPredicate;
    expect(verifyBaselineCounts(tampered, bytes)).toBe(false);

    const wrongArtifact = canonicalOutcomeSetBytes({ "tests/test_a.py::test_one": "pass" });
    expect(verifyBaselineCounts(honest, wrongArtifact)).toBe(false);
  });
});
