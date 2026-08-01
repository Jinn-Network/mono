// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../capture/paths.js";
import { type IndexDatabaseIO } from "./database.js";
import { openRelevanceIndex, type IndexableRecord, type RelevanceIndex } from "./index-store.js";
import { type SensitivityNonceIO } from "./nonce.js";
import { createSensitivityClassifier } from "./sensitivity.js";
import { RELEVANCE_FLOOR } from "./search.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const testIndexIo: IndexDatabaseIO = {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  removeFile: (path) => rm(path, { force: true }),
};

const testNonceIo: SensitivityNonceIO = {
  readFile,
  writeFile,
  ensureOwnerOnlyFile,
};

let index: RelevanceIndex;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "jinn-search-"));
  index = await openRelevanceIndex({
    databasePath: join(home, "index.sqlite"),
    indexIo: testIndexIo,
    classifier: await createSensitivityClassifier({
      noncePath: join(home, "sensitivity-nonce"),
      knownIdentities: [],
      nonceIo: testNonceIo,
    }),
    now: () => "2026-07-30T00:00:00.000Z",
  });
});

const put = async (
  seed: string,
  summary: string,
  body: string,
  overrides: Partial<IndexableRecord> = {},
): Promise<void> => {
  await index.put({
    plane: "local",
    reference: { family: "execution-evidence", digest: digest(seed) },
    summary,
    origin: "urn:jinn:agent:one",
    capturedAt: "2026-07-12T09:00:00.000Z",
    outcome: "completed",
    excerpts: body.length === 0
      ? []
      : [{ label: "note", sourceEntityId: "trace", sourceDigest: digest("f"), text: body }],
    ...overrides,
  });
};

describe("ranking", () => {
  test("coverage counts distinct terms, never repetitions", async () => {
    await put("a", "flaky index rebuild", "");
    await put("b", "flaky flaky flaky flaky flaky flaky flaky flaky", "");
    const hits = await index.search({ terms: ["flaky", "rebuild"], floor: 1 });
    const byDigest = new Map(hits.map((hit) => [hit.reference.digest, hit]));
    expect(byDigest.get(digest("a"))!.coverage).toBe(2);
    expect(byDigest.get(digest("b"))!.coverage).toBe(1);
  });

  test("the floor is honest: a single match yields nothing", async () => {
    await put("b", "flaky flaky flaky", "");
    expect(await index.search({ terms: ["flaky", "rebuild"] })).toHaveLength(0);
    expect(RELEVANCE_FLOOR).toBe(2);
  });

  test("summary matches outrank body-only matches", async () => {
    await put("a", "flaky rebuild of the corpus index", "unrelated prose");
    await put("b", "unrelated title", "flaky rebuild corpus index");
    const hits = await index.search({ terms: ["flaky", "rebuild", "corpus", "index"] });
    expect(hits[0]!.reference.digest).toBe(digest("a"));
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("matchedTerms reports what actually matched", async () => {
    await put("a", "flaky rebuild", "");
    const [hit] = await index.search({ terms: ["flaky", "rebuild", "absent"], floor: 2 });
    expect(hit!.matchedTerms).toEqual(["flaky", "rebuild"]);
  });

  test("the local plane wins an exact tie", async () => {
    await put("a", "identical summary text", "", { plane: "public" });
    await put("a", "identical summary text", "", { plane: "local" });
    const hits = await index.search({ terms: ["identical", "summary"] });
    expect(hits.map((hit) => hit.plane)).toEqual(["local", "public"]);
  });

  test("recency breaks a same-plane tie, digest breaks a same-instant tie", async () => {
    await put("a", "same words here", "", { capturedAt: "2026-01-01T00:00:00.000Z" });
    await put("b", "same words here", "", { capturedAt: "2026-06-01T00:00:00.000Z" });
    await put("c", "same words here", "", { capturedAt: "2026-06-01T00:00:00.000Z" });
    const hits = await index.search({ terms: ["same", "words"] });
    expect(hits[0]!.reference.digest).toBe(digest("b"));
    expect(hits.slice(1).map((hit) => hit.reference.digest)).toEqual([digest("c"), digest("a")]);
  });

  test("plane filtering is honoured", async () => {
    await put("a", "shared words here", "", { plane: "public" });
    await put("b", "shared words here", "", { plane: "local" });
    const publicOnly = await index.search({ terms: ["shared", "words"], planes: ["public"] });
    expect(publicOnly.map((hit) => hit.plane)).toEqual(["public"]);
  });

  test("camelCase in a record is found by its parts", async () => {
    await put("a", "the parseTrajectory helper", "sealRecord path");
    const hits = await index.search({ terms: ["trajectory", "record"], floor: 2 });
    expect(hits).toHaveLength(1);
  });

  test("no terms, unsearchable terms, and an empty index all yield nothing", async () => {
    expect(await index.search({ terms: [] })).toHaveLength(0);
    expect(await index.search({ terms: ["---", "..."] })).toHaveLength(0);
    expect(await index.search({ terms: ["absent", "missing"] })).toHaveLength(0);
  });

  test("FTS5 operators inside a term cannot steer the matcher", async () => {
    await put("a", "alpha content", "");
    await put("b", "beta content", "");
    const hits = await index.search({ terms: ['alpha" OR "beta', "content"], floor: 1 });
    expect(hits.map((hit) => hit.reference.digest)).toEqual([digest("a"), digest("b")].slice(0, hits.length));
    expect(hits.every((hit) => hit.coverage <= 2)).toBe(true);
  });

  test("the limit caps results after ranking, not before", async () => {
    for (const seed of ["a", "b", "c", "d"]) await put(seed, "same words here", "");
    expect(await index.search({ terms: ["same", "words"], limit: 2 })).toHaveLength(2);
  });

  test("excerpts come back attributed", async () => {
    await put("a", "flaky rebuild", "yarn test --no-threads");
    const [hit] = await index.search({ terms: ["flaky", "rebuild"] });
    expect(hit!.excerpts[0]!.sourceEntityId).toBe("trace");
    expect(hit!.excerpts[0]!.sourceDigest).toBe(digest("f"));
    expect(hit!.excerpts[0]!.label).toBe("note");
  });
});
