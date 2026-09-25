// SPDX-License-Identifier: Apache-2.0

/**
 * The generated capability lattice (bundle-capability-composition design §9; issue #3403).
 *
 * The closure model's real product was that a human had written down, per shape, exactly what must
 * be there. Composition has to reproduce that certainty without reproducing that labor, so this
 * suite enumerates every subset of the registry -- 2^n cases for n capabilities -- instead of the
 * cells someone remembered to write a fixture for. A capability registered later is covered by
 * every case here without an edit.
 *
 * For each subset the registry's `requires`/`conflicts` admit, it asserts the composed member list,
 * the composed check list, the claim section set, and the derived reader release; and, for every
 * capability NOT in the subset, that planting one of its members is refused as non-allowlisted and
 * that declaring it without its members is refused as a missing member. Each subset the registry
 * does not admit must be refused at resolution.
 *
 * The expectations are computed here from the registry ENTRIES, never from `composeClosure` -- a
 * lattice that compared the derivation to itself would prove nothing. The closure runs through
 * `assertMemberClosure`, the same function the verifier runs over a real bundle's manifest.
 */

import { describe, expect, test } from "vitest";
import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import { PUBLIC_BUNDLE_FILES, PUBLIC_BUNDLE_VERIFICATION_CHECKS } from "./legacy-closures.js";
import { expectRefusal } from "./testing/expect-refusal.js";
import {
  CAPABILITY_REGISTRY,
  COMPOSED_FORMAT_MINIMUM_READER_RELEASE,
  assertMemberClosure,
  compareReaderReleases,
  composeClosure,
  type CapabilityEntry,
} from "./capabilities.js";

const REGISTRY: readonly CapabilityEntry[] = CAPABILITY_REGISTRY;
const DIGEST = "c".repeat(64);
const RECORD_PATH = `records/${DIGEST}.bin`;

/** One concrete path of each shape an entry allowlists. The registry's shapes are all
 * content-addressed today; a shape of another kind needs its sample stated here. */
function sampleMember(pattern: RegExp): string {
  const sample = [`anchors/${DIGEST}.bin`].find((candidate) => pattern.test(candidate));
  if (sample === undefined) throw new Error(`the lattice has no sample member for the shape ${String(pattern)}`);
  return sample;
}

/** Every member an entry can contribute: its exact paths, and one sample per shape. */
function membersOf(entry: CapabilityEntry): string[] {
  return [...entry.mandatoryFiles, ...entry.memberPatterns.map(({ pattern }) => sampleMember(pattern))];
}

const SUBSETS: readonly (readonly CapabilityEntry[])[] = Array.from(
  { length: 2 ** REGISTRY.length },
  (_, mask) => REGISTRY.filter((__, index) => (mask & (1 << index)) !== 0),
);

const vectorOf = (subset: readonly CapabilityEntry[]): string[] =>
  subset.map((entry) => entry.token).sort(compareCodeUnitStrings);

function admitted(subset: readonly CapabilityEntry[]): boolean {
  const tokens = new Set(subset.map((entry) => entry.token));
  return subset.every((entry) =>
    entry.requires.every((token) => tokens.has(token)) && entry.conflicts.every((token) => !tokens.has(token)));
}

/** A complete, exactly-closed manifest path set for `subset`: the base graph, one evidence record,
 * and every member each declared capability contributes. */
function closedManifest(subset: readonly CapabilityEntry[]): Set<string> {
  return new Set([...PUBLIC_BUNDLE_FILES, RECORD_PATH, ...subset.flatMap(membersOf)]);
}

describe("the generated lattice", () => {
  test("covers every subset of the registry", () => {
    expect(SUBSETS).toHaveLength(2 ** REGISTRY.length);
    expect(new Set(SUBSETS.map((subset) => vectorOf(subset).join(","))).size).toBe(SUBSETS.length);
    // Both kinds of cell must exist, or one half of this suite silently asserts nothing.
    expect(SUBSETS.some(admitted)).toBe(true);
    expect(SUBSETS.some((subset) => !admitted(subset))).toBe(true);
  });

  for (const subset of SUBSETS) {
    const vector = vectorOf(subset);
    const label = JSON.stringify(vector);

    if (!admitted(subset)) {
      test(`${label} is refused at resolution, before any member is read`, () => {
        const refusal = expectRefusal(() => composeClosure(vector));
        expect(refusal.code).toBe("record-integrity");
        expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
      });
      continue;
    }

    describe(label, () => {
      const byOrder = [...subset].sort((left, right) => left.order - right.order);

      test("composes exactly the declared capabilities' members, checks, sections, and release", () => {
        const closure = composeClosure(vector);
        expect(closure.capabilities).toEqual(vector);
        expect(closure.mandatoryFiles).toEqual([...PUBLIC_BUNDLE_FILES, ...byOrder.flatMap((entry) => entry.mandatoryFiles)]);
        expect(closure.memberPatterns).toEqual(byOrder.flatMap((entry) => entry.memberPatterns));
        expect(closure.checks).toEqual([...PUBLIC_BUNDLE_VERIFICATION_CHECKS, ...byOrder.flatMap((entry) => entry.checks)]);
        // A capability without a section (`slot-denominators`) contributes none.
        expect(closure.claimSections)
          .toEqual(byOrder.flatMap((entry) => entry.claimSection === undefined ? [] : [entry.claimSection]));
        expect([...closure.refinedMembers.keys()].sort()).toEqual(byOrder.flatMap((entry) => entry.refines).sort());
        // Role derivations compose like everything else: the declared capabilities' and no others.
        // Both halves of what that buys -- a record reachable only through a declared contribution
        // verifies, and the same record under a vector that omits it is refused as unreachable by
        // `evidence-closure` -- need a signed qualification graph, so they run against real bundles
        // in the product core's `v10-materialize.test.ts`.
        expect(closure.roleDerivations).toEqual(byOrder.flatMap((entry) => entry.roleDerivations));
        const releases = [COMPOSED_FORMAT_MINIMUM_READER_RELEASE, ...subset.map((entry) => entry.minimumReaderRelease)];
        expect(closure.minimumReaderRelease).toBe(releases.sort(compareReaderReleases).at(-1));
      });

      test("the claim's pins are the ones its sections alone derive", () => {
        // A claim states its check list and reader line, and the claim schema re-derives both from
        // the vector its SECTIONS imply, which cannot see a capability without one. So dropping
        // every section-less capability from the vector must leave both pins where they were.
        const sectioned = subset.filter((entry) => entry.claimSection !== undefined);
        const closure = composeClosure(vector);
        const fromSections = composeClosure(vectorOf(sectioned));
        expect(closure.checks).toEqual(fromSections.checks);
        expect(closure.minimumReaderRelease).toBe(fromSections.minimumReaderRelease);
      });

      test("an exactly-closed manifest passes", () => {
        expect(() => assertMemberClosure(composeClosure(vector), closedManifest(subset), [RECORD_PATH])).not.toThrow();
      });

      test("a record the evidence catalog does not name is refused", () => {
        const stray = `records/${"d".repeat(64)}.bin`;
        const refusal = expectRefusal(() =>
          assertMemberClosure(composeClosure(vector), new Set([...closedManifest(subset), stray]), [RECORD_PATH]));
        expect(refusal.issues[0]).toEqual(expect.objectContaining({ path: stray }));
      });

      for (const declared of subset) {
        for (const path of declared.mandatoryFiles) {
          test(`stripping ${declared.token}'s "${path}" is a missing member, never a quieter bundle`, () => {
            const stripped = closedManifest(subset);
            stripped.delete(path);
            const refusal = expectRefusal(() => assertMemberClosure(composeClosure(vector), stripped, [RECORD_PATH]));
            expect(refusal.issues[0]).toEqual(expect.objectContaining({ path }));
            expect(refusal.issues[0]!.message).toContain("is missing");
          });
        }
        for (const { pattern, mayBeEmpty } of declared.memberPatterns) {
          test(`${declared.token} with no member of the shape ${String(pattern)} ${mayBeEmpty ? "passes, as the registry opts in" : "is refused"}`, () => {
            const stripped = closedManifest(subset);
            stripped.delete(sampleMember(pattern));
            const run = () => assertMemberClosure(composeClosure(vector), stripped, [RECORD_PATH]);
            if (mayBeEmpty) expect(run).not.toThrow();
            else expect(expectRefusal(run).issues[0]!.message).toContain("is missing");
          });
        }
      }

      for (const undeclared of REGISTRY.filter((entry) => !subset.includes(entry))) {
        for (const path of membersOf(undeclared)) {
          test(`planting undeclared ${undeclared.token}'s "${path}" is a non-allowlisted file`, () => {
            const planted = new Set([...closedManifest(subset), path]);
            const refusal = expectRefusal(() => assertMemberClosure(composeClosure(vector), planted, [RECORD_PATH]));
            expect(refusal.issues[0]).toEqual(expect.objectContaining({ path }));
            expect(refusal.issues[0]!.message).toContain("non-allowlisted");
          });
        }

        const widened = vectorOf([...subset, undeclared]);
        if (!admitted([...subset, undeclared])) continue;
        const required = [
          ...undeclared.mandatoryFiles,
          ...undeclared.memberPatterns.filter(({ mayBeEmpty }) => !mayBeEmpty).map(({ pattern }) => sampleMember(pattern)),
        ];
        // A capability with no member of its own (`disclosure-specification`), or whose members may
        // be absent (`anchoring`), has nothing for the MEMBER closure to miss. Declaring one over a
        // bundle that does not carry it is refused by that capability's own check and by the claim
        // rebuild instead, which the end-to-end suites exercise against real bundles.
        if (required.length === 0) continue;
        test(`declaring ${undeclared.token} without its members is a missing member`, () => {
          const refusal = expectRefusal(() => assertMemberClosure(composeClosure(widened), closedManifest(subset), [RECORD_PATH]));
          expect(refusal.issues[0]).toEqual(expect.objectContaining({ path: required[0] }));
          expect(refusal.issues[0]!.message).toContain("is missing");
        });
      }
    });
  }
});

describe("a shape that may not be empty", () => {
  // No registered capability opts out of `mayBeEmpty` yet, so the refusal is pinned against a
  // registry that does: the flag is part of the per-entry contract, and its strict half must not be
  // discovered untested by the first capability that needs it.
  const strict: CapabilityEntry = {
    token: "strict-members",
    order: 1,
    requires: [],
    conflicts: [],
    mandatoryFiles: [],
    memberPatterns: [{ pattern: /^strict\/[a-f0-9]{64}\.bin$/u, mayBeEmpty: false }],
    refines: [],
    roleDerivations: [],
    claimSection: "strict",
    checks: [],
    minimumReaderRelease: "verify@0.2.1",
    activation: () => false,
  };

  test("declared with no member of the shape is refused; with one, it passes", () => {
    const closure = composeClosure(["strict-members"], [strict]);
    const refusal = expectRefusal(() => assertMemberClosure(closure, new Set(PUBLIC_BUNDLE_FILES), []));
    expect(refusal.issues[0]!.message).toContain("is missing every member of the shape");
    expect(() => assertMemberClosure(closure, new Set([...PUBLIC_BUNDLE_FILES, `strict/${DIGEST}.bin`]), [])).not.toThrow();
  });
});
