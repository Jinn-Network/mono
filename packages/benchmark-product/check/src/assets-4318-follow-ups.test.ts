// SPDX-License-Identifier: Apache-2.0

/**
 * Regression pins for the remaining PR #4318 review follow-ups (sweep #4775).
 *
 * #4418 deleted the unreachable binary branch of `pairedCompactFragment`. #4420 discharged
 * the stale `deferred to #2982` rows in vocabulary spec §4.2. #4419's stay-open instruction
 * for #4270 was lost to the post-merge member closer; the hold is carried at the emission
 * site and in the spec row, not by an open GitHub issue.
 *
 * #4836 then ruled that split deliberately, after finding the closer's `Deferred` escape
 * hatch: a durable reopen was available and was declined. The pin below guards the ruling
 * and the corrected v1.9 sentence, which had read as though no reopen could ever hold.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ASSETS_SRC = readFileSync(new URL("./assets.ts", import.meta.url), "utf8");
const VOCABULARY_SPEC = "docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md";
const VOCABULARY_SPEC_PATH = fileURLToPath(new URL(`../../../../${VOCABULARY_SPEC}`, import.meta.url));

const DEAD_SIGNPOST = "Verified qualification signpost · full evidence at index.html";

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} in assets.ts`).toBeGreaterThanOrEqual(0);
  const next = source.slice(start + 1).search(/\nfunction /);
  expect(next, `function following ${name}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 1 + next);
}

function section42(spec: string): string {
  const start = spec.indexOf("### 4.2 Reader tool output");
  expect(start, `${VOCABULARY_SPEC} §4.2 heading`).toBeGreaterThanOrEqual(0);
  const end = spec.indexOf("### 4.3 ", start);
  expect(end, `${VOCABULARY_SPEC} §4.3 heading after §4.2`).toBeGreaterThan(start);
  return spec.slice(start, end);
}

describe("PR #4318 follow-ups (#4418, #4419, #4420)", () => {
  test("#4418: pairedCompactFragment excludes BinaryFacts and does not emit the dead signpost", () => {
    const fragment = functionSource(ASSETS_SRC, "pairedCompactFragment");
    expect(fragment).toContain("Exclude<MethodFacts, BinaryFacts>");
    expect(fragment).not.toContain('facts.kind === "binary"');
    expect(fragment).not.toContain(DEAD_SIGNPOST);
    // The string must not remain anywhere in this file as a rendered literal. Comments that
    // quote it as a historical name (the vocabulary spec, not this emitter) are out of scope.
    expect(ASSETS_SRC).not.toContain(DEAD_SIGNPOST);
  });

  test("#4419: the #4270 hold is recorded at the emission site after the GitHub issue was auto-closed", () => {
    const hold = functionSource(ASSETS_SRC, "buildBadge");
    // The comment lives immediately above `buildBadge`; `functionSource` starts at the function,
    // so read the preceding comment block from the full file instead.
    const badgeAt = ASSETS_SRC.indexOf("function buildBadge");
    const holdComment = ASSETS_SRC.slice(ASSETS_SRC.lastIndexOf("// The retired verdict word", badgeAt), badgeAt);
    expect(holdComment).toContain("#4270");
    expect(holdComment).toContain("bundle-format allocation");
    expect(holdComment).toContain("auto-closed after PR #4318");
    expect(holdComment).toContain("#4419");
    // #4836 ruled that split deliberately; the comment must keep pointing at that ruling.
    expect(holdComment).toContain("#4836");
    expect(hold, "buildBadge remains the emission site").toContain("function buildBadge");

    const spec = readFileSync(VOCABULARY_SPEC_PATH, "utf8");
    expect(spec).toContain("auto-closed after PR #4318");
    expect(spec).toMatch(/\*\*v1\.9\*\* \(#4775/);
  });

  test("#4836: the two records are the registry by decision, and v1.9 no longer reads as unconditional", () => {
    const spec = readFileSync(VOCABULARY_SPEC_PATH, "utf8");
    // The v1.9 sentence claimed reopening #4270 could not hold. It can: the member closer in
    // Autopilot's `fileDebtSweep`/`fileResidueSweep` skips any member named under a `Deferred`
    // heading on the merged sweep PR body (`parseDeferredMembers`).
    expect(spec).not.toContain("Reopening it would be closed again by the same closer");

    const start = spec.indexOf("- **v1.10** (#4836");
    expect(start, `${VOCABULARY_SPEC} v1.10 changelog entry`).toBeGreaterThanOrEqual(0);
    const end = spec.indexOf("\n## 1. Scope", start);
    expect(end, `${VOCABULARY_SPEC} §1 heading after the v1.10 entry`).toBeGreaterThan(start);
    const v110 = spec.slice(start, end);
    // The ruling itself, the mechanism that made the option real, and that it was a choice
    // rather than the absence of an option.
    expect(v110).toContain("parseDeferredMembers");
    expect(v110).toContain("`Deferred` heading");
    expect(v110).toContain("**declined**");
  });

  test("#4420: vocabulary spec §4.2 no longer defers the three rows to #2982", () => {
    const spec42 = section42(readFileSync(VOCABULARY_SPEC_PATH, "utf8"));
    expect(spec42).not.toContain("deferred to #2982");
    expect(spec42).not.toMatch(/cli\.ts:\d+/);
    expect(spec42).toContain("Recomputed: N of N checks passed");
    expect(spec42).toContain("PLATFORM_BYTES_SENTENCE");
    expect(spec42).toContain("Not checked by this tool:");
    expect(spec42).toContain("renderVerifiedBundle");
  });
});
