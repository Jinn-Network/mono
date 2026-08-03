// SPDX-License-Identifier: MIT

/**
 * Derivation-equivalence conformance (substrate §4.1, §8).
 *
 * The fixture on disk is the arbiter. This suite runs the kit's naive reference deriver against
 * it today; when C1's implementation lands and `conformance.ts` is repointed, the SAME assertions
 * run against the second implementation. Two structurally different code paths, one set of
 * expected bytes — which is what "two honest derivers MUST produce identical bytes" means
 * operationally.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  canonicalTupleText,
  deriveExecutionTuple,
  expressAsRunPinning,
  prefixedDigest,
  tupleDigest,
} from "./conformance.js";
import { loadFixtureDirectory, outcomeOf } from "./fixtures.js";
import type { ResolvedTaskProfile, SealedSubmissionDoc, SealedTaskDoc } from "./types.js";

interface DerivationFixture {
  readonly name: string;
  readonly profile: ResolvedTaskProfile;
  readonly task: SealedTaskDoc;
  readonly submission: SealedSubmissionDoc;
  readonly venueKnowledge?: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

const golden = loadFixtureDirectory("derivation", "golden") as unknown as DerivationFixture[];
const adversarial = loadFixtureDirectory("derivation", "adversarial") as unknown as DerivationFixture[];

describe("derivation — golden", () => {
  for (const fixture of golden) {
    const expected = fixture.expect as {
      taskDigest: string;
      submissionDigest: string;
      canonicalTuple: string;
      tupleDigest: string;
      absentTupleKeys: string[];
      mustNotContain: string[];
      runPinning: Record<string, unknown>;
    };

    it(`${fixture.name}: the fixture's Task and Submission seal to the pinned digests`, () => {
      // Self-verifying fixture: if someone edits either document, this fails before any
      // derivation assertion does, so the failure names the real cause.
      expect(prefixedDigest(canonicalJsonBytes(fixture.task))).toBe(expected.taskDigest);
      expect(prefixedDigest(canonicalJsonBytes(fixture.submission))).toBe(expected.submissionDigest);
    });

    it(`${fixture.name}: the Submission's task reference binds to that exact Task`, () => {
      const bound = (fixture.submission["task"] as { digest?: Record<string, string> } | undefined)
        ?.digest?.["sha256"];
      expect(`sha256:${bound}`).toBe(expected.taskDigest);
    });

    it(`${fixture.name}: derives the expected canonical tuple bytes`, () => {
      const tuple = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      expect(canonicalTupleText(tuple)).toBe(expected.canonicalTuple);
    });

    it(`${fixture.name}: derives the expected tuple digest`, () => {
      const tuple = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      expect(tupleDigest(tuple)).toBe(expected.tupleDigest);
    });

    it(`${fixture.name}: is deterministic across repeated derivations`, () => {
      const first = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      const second = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      expect(canonicalTupleText(second)).toBe(canonicalTupleText(first));
    });

    it(`${fixture.name}: omits declared-but-unset profile keys and excludes foreign keys`, () => {
      const tuple = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      for (const key of expected.absentTupleKeys) {
        // "omitted, never null-filled" — `null` would be a present member and would fail this.
        expect(Object.hasOwn(tuple, key)).toBe(false);
      }
    });

    it(`${fixture.name}: honors the enrichment ban — no venue knowledge reaches the bytes`, () => {
      const tuple = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      const text = canonicalTupleText(tuple);
      for (const forbidden of expected.mustNotContain) {
        expect(text).not.toContain(forbidden);
      }
    });

    it(`${fixture.name}: expresses back as the expected run pinning`, () => {
      const tuple = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
      expect(expressAsRunPinning(tuple)).toEqual(expected.runPinning);
    });
  }
});

describe("derivation — adversarial", () => {
  for (const fixture of adversarial) {
    const expected = fixture.expect as { ok: false; code: string; path: string };
    it(`${fixture.name}: fails closed with ${expected.code} and yields NO tuple`, () => {
      const outcome = outcomeOf(() =>
        deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(expected.code);
      expect(outcome.path).toBe(expected.path);
    });
  }
});

describe("derivation is a function of the documents, not of their spelling", () => {
  it("permuting member order in the Task and Submission does not change the derived tuple", () => {
    const fixture = golden.find((entry) => entry.name === "equivalence-primary");
    if (fixture === undefined) throw new Error("equivalence-primary fixture is missing");

    const reverseMembers = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;

    const permutedTask = {
      ...reverseMembers(fixture.task),
      requirements: reverseMembers((fixture.task["requirements"] ?? {}) as Record<string, unknown>),
    } as SealedTaskDoc;
    const permutedSubmission = {
      ...reverseMembers(fixture.submission),
      requirements: reverseMembers(
        (fixture.submission["requirements"] ?? {}) as Record<string, unknown>,
      ),
    } as SealedSubmissionDoc;

    const original = deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile);
    const permuted = deriveExecutionTuple(permutedTask, permutedSubmission, fixture.profile);
    expect(canonicalTupleText(permuted)).toBe(canonicalTupleText(original));
  });

  it("reordering the profile's requirementKeys does not change the derived tuple", () => {
    const fixture = golden.find((entry) => entry.name === "equivalence-primary");
    if (fixture === undefined) throw new Error("equivalence-primary fixture is missing");
    const reordered: ResolvedTaskProfile = {
      ...fixture.profile,
      requirementKeys: [...fixture.profile.requirementKeys].reverse(),
    };
    expect(canonicalTupleText(deriveExecutionTuple(fixture.task, fixture.submission, reordered))).toBe(
      canonicalTupleText(deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile)),
    );
  });
});
