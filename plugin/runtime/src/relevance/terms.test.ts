// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  deriveRepositorySearchTerms,
  deriveSearchTerms,
  discriminatingTerms,
} from "./terms.js";

describe("term derivation", () => {
  test("quoted and backticked spans come first, near-verbatim", () => {
    const terms = deriveSearchTerms("please run `yarn test --no-threads` then check \"flaky spec\"");
    expect(terms[0]).toBe("yarn test --no-threads");
    expect(terms[1]).toBe("flaky spec");
  });

  test("identifier-shaped tokens outrank ordinary prose", () => {
    const terms = deriveSearchTerms("the parseTrajectory helper in client/src/dashboard broke");
    expect(terms.indexOf("parsetrajectory")).toBeLessThan(terms.indexOf("helper"));
    expect(terms).toContain("client/src/dashboard");
  });

  test("the repository NAME is a term, the full slug is not", () => {
    expect(deriveRepositorySearchTerms("Jinn-Network/mono")).toEqual(["mono"]);
    expect(deriveRepositorySearchTerms("Jinn-Network/ab")).toEqual([]);
    expect(deriveRepositorySearchTerms(undefined)).toEqual([]);
    expect(deriveSearchTerms("fix the indexer", "Jinn-Network/mono")).toContain("mono");
    expect(deriveSearchTerms("fix the indexer", "Jinn-Network/mono")).not.toContain(
      "jinn-network/mono",
    );
  });

  test("remaining tokens keep message order, not longest-first", () => {
    const terms = deriveSearchTerms("flaky deterministic ordering");
    expect(terms).toEqual(["flaky", "deterministic", "ordering"]);
  });

  test("stopwords and short tokens are dropped", () => {
    expect(deriveSearchTerms("can you help me with the thing")).toEqual(["thing"]);
  });

  test("sentence punctuation never becomes part of a term", () => {
    expect(deriveSearchTerms("the build failed. rerun jobs.")).toEqual([
      "build",
      "failed",
      "rerun",
      "jobs",
    ]);
  });

  test("terms are lowercased, deduplicated, and budget-capped", () => {
    const terms = deriveSearchTerms("Alpha alpha ALPHA beta gamma delta epsilon zeta eta theta iota kappa", undefined, 4);
    expect(terms).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  test("an empty or whitespace message yields no terms", () => {
    expect(deriveSearchTerms("")).toEqual([]);
    expect(deriveSearchTerms("   \n  ")).toEqual([]);
  });

  test("discriminatingTerms removes the repository name only", () => {
    const terms = deriveSearchTerms("fix the flaky indexer in mono", "Jinn-Network/mono");
    expect(terms).toContain("mono");
    expect(discriminatingTerms(terms, "Jinn-Network/mono")).not.toContain("mono");
    expect(discriminatingTerms(terms, "Jinn-Network/mono")).toContain("indexer");
    expect(discriminatingTerms(terms, undefined)).toEqual(terms);
  });
});
