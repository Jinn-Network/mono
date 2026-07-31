// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalSpecBytes,
  checkCandidateSpecConsistency,
  checkInlineEnvironmentMatch,
} from "@jinn-network/task-admission";
import { describe, expect, it } from "vitest";
import { buildCandidateEvaluationSpec, buildSealedTask } from "../seal-pair.js";
import { buildFixtureCandidate, buildFixtureEnvironment } from "../testing-support.js";

/**
 * The seam nothing else pins: C4 seals EvaluationSpec bytes with profiles' sealer, and C3
 * admits only bytes that equal trust-core's canonicalization of the same document. The two
 * canonicalizers agree today, but no suite in either package holds them to it — a drift in
 * either would refuse every real C4 pair as `invalid-candidate`, and only production would
 * find out. This runs C3's own checks against a genuinely C4-sealed pair.
 */
describe("a C4-sealed pair satisfies C3's pre-run checks", () => {
  const env = buildFixtureEnvironment();
  const candidate = buildFixtureCandidate();
  const spec = buildCandidateEvaluationSpec(candidate, env);
  const parsed = JSON.parse(new TextDecoder().decode(spec.bytes)) as unknown;

  it("seals bytes that are the document's canonical encoding by C3's canonicalizer", () => {
    expect(() => assertCanonicalSpecBytes(spec.bytes, parsed)).not.toThrow();
  });

  it("matches the record inline, and carries the environment-record spec key C3 reads", () => {
    expect(checkInlineEnvironmentMatch(env.record, parsed, env.recordDigest)).toEqual({
      fields: ["image", "parser", "platform"],
      specKeyPresent: true,
    });
  });

  it("grades exactly the transitions and test material the candidate declares", () => {
    expect(() =>
      checkCandidateSpecConsistency(parsed, {
        transitions: candidate.transitions,
        testMaterialDigests: candidate.testMaterial.map((material) => material.digest),
      }),
    ).not.toThrow();
  });

  it("seals a Task whose evaluation reference is that spec's digest", () => {
    const task = buildSealedTask(candidate, env, spec.digest);
    const document = JSON.parse(new TextDecoder().decode(task.bytes)) as {
      evaluation: { digest: { sha256: string } };
    };
    expect(document.evaluation.digest.sha256).toBe(spec.digest.slice("sha256:".length));
  });
});
