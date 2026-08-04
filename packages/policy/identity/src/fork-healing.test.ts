// SPDX-License-Identifier: MIT

/**
 * Fork-healing conformance — `learner-public.v1` and the fail-closed materialization rule
 * (substrate §4.2, §8).
 *
 * The digest constant here is C3's. Both units compute it from independent implementations of
 * the same profile over the same tree; if they ever disagree, one of them has drifted and the
 * `codeDigest` ↔ loadout-digest fork the substrate exists to heal has quietly reopened.
 */

import { describe, expect, it } from "vitest";

import { assertMaterializable, hashTreeLearnerPublicV1, sha256Hex } from "./conformance.js";
import { outcomeOf, readFixture } from "./fixtures.js";
import {
  LEARNER_PUBLIC_V1,
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  LEARNER_PUBLIC_V1_EXCLUDED_ROOTS,
} from "./tokens.js";
import type { TreeEntry } from "./types.js";

interface TreeFixture {
  readonly profile: string;
  readonly entries: TreeEntry[];
  readonly expect: Record<string, unknown>;
}

const encoder = new TextEncoder();

const golden = readFixture<TreeFixture>("fork-healing/tree-golden.json");
const withoutExcluded = readFixture<TreeFixture>("fork-healing/tree-without-excluded-roots.json");
const smuggled = readFixture<TreeFixture & { MUST_REJECT_AT_MATERIALIZATION: boolean }>(
  "fork-healing/smuggled-git-hooks.json",
);
const failClosed = readFixture<{
  cases: { name: string; why: string; entries: TreeEntry[]; expect: Record<string, unknown> }[];
}>("fork-healing/fail-closed.json");

/** C3's pinned constant (`client/test/harnesses/hash-profile.test.ts`). */
const FORK_HEALING_FIXTURE_DIGEST =
  "90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8";

describe("the profile's own constants", () => {
  it("names the profile C3 registers", () => {
    expect(golden.profile).toBe(LEARNER_PUBLIC_V1);
  });

  it("pins the exhaustive top-level classification C3's suite asserts", () => {
    expect([...LEARNER_PUBLIC_V1_ALLOWED_DIRS].sort()).toEqual([
      ".archive", "agents", "configs", "hooks", "notes", "patterns",
      "plans", "runs", "skills", "strategies", "tests", "tools", "tunables",
    ]);
    expect([...LEARNER_PUBLIC_V1_ALLOWED_FILES]).toEqual(["policy.json"]);
    expect([...LEARNER_PUBLIC_V1_EXCLUDED_ROOTS]).toEqual([
      ".git", "operator-requests", "secrets", "transcripts",
    ]);
  });
});

describe("the fork-healing fixture tree (substrate §4.2/§8)", () => {
  it("hashes to C3's pinned digest — the cross-unit byte-match", () => {
    expect(hashTreeLearnerPublicV1(golden.entries)).toBe(FORK_HEALING_FIXTURE_DIGEST);
    expect(golden.expect["digest"]).toBe(FORK_HEALING_FIXTURE_DIGEST);
  });

  it("the recorded per-file hashes are the ones the outer digest is built from", () => {
    const contributing = golden.expect["contributingFiles"] as { path: string; sha256: string }[];
    for (const { path, sha256 } of contributing) {
      const entry = golden.entries.find((candidate) => candidate.path === path);
      expect(entry?.content).toBeDefined();
      expect(sha256Hex(encoder.encode(entry?.content ?? ""))).toBe(sha256);
    }
  });

  it("the outer input is the path-sorted `<path>:<hex>` lines joined with LF, no trailing newline", () => {
    // Spelled out so a second implementation can reproduce the constant from the fixture alone,
    // without reading either implementation's code.
    const outerInput = golden.expect["outerInput"] as string;
    expect(outerInput.endsWith("\n")).toBe(false);
    expect(outerInput.split("\n")).toEqual([...outerInput.split("\n")].sort());
    expect(sha256Hex(encoder.encode(outerInput))).toBe(FORK_HEALING_FIXTURE_DIGEST);
  });

  it("excluded roots contribute nothing: the tree without them has the SAME digest", () => {
    expect(hashTreeLearnerPublicV1(withoutExcluded.entries)).toBe(FORK_HEALING_FIXTURE_DIGEST);
  });

  it("but content under a CONTRIBUTING root does move the digest", () => {
    const edited = golden.entries.map((entry) =>
      entry.path === "skills/alpha/SKILL.md" ? { ...entry, content: "# alpha v2\n" } : entry,
    );
    expect(hashTreeLearnerPublicV1(edited)).not.toBe(FORK_HEALING_FIXTURE_DIGEST);
  });

  it("entry order in the input does not change the digest — the profile sorts", () => {
    expect(hashTreeLearnerPublicV1([...golden.entries].reverse())).toBe(FORK_HEALING_FIXTURE_DIGEST);
  });

  it("differs from the pre-migration `.git`-only digest of the same tree (the recorded break)", () => {
    // Pre-migration on-chain codeDigests are a permanently non-joining legacy population
    // (§4.2). Modelled here by hashing the tree with ONLY `.git` excluded.
    const legacyLines = golden.entries
      .filter((entry) => !entry.path.startsWith(".git"))
      .map((entry) => `${entry.path}:${sha256Hex(encoder.encode(entry.content ?? ""))}`)
      .sort();
    expect(sha256Hex(encoder.encode(legacyLines.join("\n")))).not.toBe(FORK_HEALING_FIXTURE_DIGEST);
  });
});

describe("fail-closed classification", () => {
  for (const testCase of failClosed.cases) {
    const expected = testCase.expect as {
      ok: boolean;
      code?: string;
      path?: string;
      digest?: string;
      materializable?: boolean;
    };
    if (expected.ok) {
      it(`${testCase.name}: succeeds — ${testCase.why.split(".")[0]}`, () => {
        expect(hashTreeLearnerPublicV1(testCase.entries)).toBe(expected.digest);
      });
      it(`${testCase.name}: is still refused at materialization`, () => {
        expect(outcomeOf(() => assertMaterializable(testCase.entries)).ok).toBe(
          expected.materializable === true,
        );
      });
    } else {
      it(`${testCase.name}: fails closed with ${expected.code} at ${expected.path}`, () => {
        const outcome = outcomeOf(() => hashTreeLearnerPublicV1(testCase.entries));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe(expected.code);
        expect(outcome.path).toBe(expected.path);
      });
    }
  }
});

describe("the smuggled ignored-root package (substrate §4.2 — MUST REJECT AT MATERIALIZATION)", () => {
  it("is flagged in the fixture itself so no consumer can adopt it by accident", () => {
    expect(smuggled.MUST_REJECT_AT_MATERIALIZATION).toBe(true);
  });

  it("DIGEST-VERIFIES — it is byte-identical to the golden digest, and that is the problem", () => {
    expect(hashTreeLearnerPublicV1(smuggled.entries)).toBe(FORK_HEALING_FIXTURE_DIGEST);
    expect(smuggled.expect["digestEqualsGolden"]).toBe(true);
  });

  it("carries executable content the digest cannot see", () => {
    const hook = smuggled.entries.find((entry) => entry.path === ".git/hooks/post-checkout");
    expect(hook?.content).toContain("#!/bin/sh");
  });

  it("is REFUSED at materialization — the refusal, not the digest, is the control", () => {
    const outcome = outcomeOf(() => assertMaterializable(smuggled.entries));
    expect(outcome).toEqual({
      ok: false,
      code: smuggled.expect["materializationRefusalCode"],
      path: ".git/hooks/post-checkout",
    });
  });

  it("every excluded root triggers the same refusal, not just `.git`", () => {
    for (const root of LEARNER_PUBLIC_V1_EXCLUDED_ROOTS) {
      const entries: TreeEntry[] = [
        ...withoutExcluded.entries,
        { path: `${root}/anything`, kind: "file", content: "x\n" },
      ];
      // Digest is unmoved...
      expect(hashTreeLearnerPublicV1(entries)).toBe(FORK_HEALING_FIXTURE_DIGEST);
      // ...and materialization refuses anyway.
      expect(outcomeOf(() => assertMaterializable(entries)).code).toBe("materialization-refused");
    }
  });

  it("a package with no excluded root IS materializable — the rule is not a blanket refusal", () => {
    expect(outcomeOf(() => assertMaterializable(withoutExcluded.entries)).ok).toBe(true);
    expect(withoutExcluded.expect["materializable"]).toBe(true);
  });
});
