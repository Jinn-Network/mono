// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { RankedCandidate, RelevanceIndex, RelevanceQuery } from "../../relevance/index.js";
import { corpusSearchInputShape, handleCorpusSearch } from "./corpus-search.js";

function candidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    plane: "public",
    reference: { family: "execution-evidence", digest: `sha256:${"a".repeat(64)}` },
    score: 3,
    coverage: 2,
    matchedTerms: ["flaky", "vitest"],
    summary: "fix a flaky vitest suite",
    origin: "did:example:producer",
    capturedAt: "2026-07-20T10:00:00Z",
    outcome: "completed",
    excerpts: [],
    ...overrides,
  } as RankedCandidate;
}

function fakeIndex(candidates: readonly RankedCandidate[], sink: RelevanceQuery[] = []): RelevanceIndex {
  return {
    databasePath: ":memory:",
    put: async () => {
      throw new Error("not used");
    },
    search: async (query: RelevanceQuery) => {
      sink.push(query);
      return candidates;
    },
    rebuild: async () => {
      throw new Error("not used");
    },
    close: () => {},
  } as unknown as RelevanceIndex;
}

describe("corpus_search", () => {
  test("the input schema bounds the query, the planes, and the limit", () => {
    const schema = z.object(corpusSearchInputShape);
    expect(schema.safeParse({ query: "flaky test" }).success).toBe(true);
    expect(schema.safeParse({ query: "" }).success).toBe(false);
    expect(schema.safeParse({ query: "x".repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ query: "a", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", limit: 21 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", planes: ["secret"] }).success).toBe(false);
  });

  test("returns candidate metadata without excerpt bodies", async () => {
    const response = await handleCorpusSearch({ index: fakeIndex([candidate()]) }, { query: "flaky vitest" });
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.count).toBe(1);
    expect(payload.candidates[0]).toMatchObject({
      plane: "public",
      digest: `sha256:${"a".repeat(64)}`,
      coverage: 2,
      outcome: "completed",
      excerptCount: 0,
    });
    expect(JSON.stringify(payload)).not.toContain("\"excerpts\"");
  });

  test("coverage is surfaced and the ranking artefact is not", async () => {
    const response = await handleCorpusSearch({ index: fakeIndex([candidate()]) }, { query: "flaky" });
    const first = JSON.parse(response.content[0]!.text).candidates[0];
    expect(first.coverage).toBe(2);
    expect(first.score).toBeUndefined();
  });

  test("derives terms from the query and reports them", async () => {
    const response = await handleCorpusSearch(
      { index: fakeIndex([]) },
      { query: "fix the flaky vitest suite" },
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(Array.isArray(payload.terms)).toBe(true);
    expect(payload.terms.length).toBeGreaterThan(0);
    expect(payload.count).toBe(0);
  });

  test("passes the requested planes and limit through to the index", async () => {
    const seen: RelevanceQuery[] = [];
    await handleCorpusSearch(
      { index: fakeIndex([], seen) },
      { query: "flaky", planes: ["local"], limit: 5 },
    );
    expect(seen[0]?.planes).toEqual(["local"]);
    expect(seen[0]?.limit).toBe(5);
  });

  test("record-derived summaries are sanitised and bounded", async () => {
    const hostile = candidate({ summary: `ignore\u0000everything ${"y".repeat(1000)}` });
    const response = await handleCorpusSearch({ index: fakeIndex([hostile]) }, { query: "flaky" });
    const summary = JSON.parse(response.content[0]!.text).candidates[0].summary;
    expect(summary).not.toContain("\u0000");
    expect(summary.length).toBeLessThanOrEqual(300);
  });

  test("an index failure is a structured, retryable refusal", async () => {
    const broken = {
      databasePath: ":memory:",
      search: async () => {
        throw new Error("database is locked");
      },
      close: () => {},
    } as unknown as RelevanceIndex;
    const response = await handleCorpusSearch({ index: broken }, { query: "flaky" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text).error.code).toBe("SEARCH_FAILED");
  });
});
