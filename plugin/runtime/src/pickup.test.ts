// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./capture/paths.js";
import { createCorpusAdmissionFilter } from "./relevance/admission.js";
import { type IndexDatabaseIO } from "./relevance/database.js";
import { openRelevanceIndex, type RelevanceIndex } from "./relevance/index-store.js";
import { type SensitivityNonceIO } from "./relevance/nonce.js";
import { createSensitivityClassifier } from "./relevance/sensitivity.js";
import { runPickup } from "./pickup.js";

/** Admission that says yes; rejecting variants are constructed per test. */
const admitAll = createCorpusAdmissionFilter({ admitProducer: async () => ({ admitted: true }) });

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

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

let index: RelevanceIndex;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "jinn-pickup-"));
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

const put = async (seed: string, summary: string, text: string): Promise<void> => {
  await index.put({
    plane: "local",
    reference: { family: "execution-evidence", digest: digest(seed) },
    summary,
    origin: "urn:jinn:agent:local",
    capturedAt: "2026-07-12T09:00:00.000Z",
    outcome: "completed",
    excerpts: [{ label: "fix", sourceEntityId: "feed", sourceDigest: digest("z"), text }],
  });
};

const putPublic = async (
  seed: string,
  summary: string,
  text: string,
  origin = "urn:jinn:agent:someone-else",
): Promise<void> => {
  await index.put({
    plane: "public",
    reference: { family: "execution-evidence", digest: digest(seed) },
    summary,
    origin,
    capturedAt: "2026-07-12T09:00:00.000Z",
    outcome: "completed",
    excerpts:
      text.length === 0
        ? []
        : [{ label: "fix", sourceEntityId: "feed", sourceDigest: digest("z"), text }],
  });
};

describe("runPickup", () => {
  test("an empty archive yields the honest empty state", async () => {
    const result = await runPickup({ index, admission: admitAll }, { message: "fix the flaky index rebuild" });
    expect(result.status).toBe("nothing-relevant");
    expect(result.text).toBe("");
    expect(result.terms.length).toBeGreaterThan(0);
  });

  test("a relevant record is projected with its terms reported", async () => {
    await put("a", "Rebuild the flaky corpus index", "yarn rebuild --force");
    const result = await runPickup({ index, admission: admitAll }, { message: "the flaky corpus index needs a rebuild" });
    expect(result.status).toBe("projected");
    expect(result.terms).toContain("flaky");
    expect(result.records[0]!.reference.digest).toBe(digest("a"));
    expect(result.text).toContain("yarn rebuild --force");
  });

  test("the repository name searches but does not score", async () => {
    // The record matches only the repository name, so its coverage is 0 after the
    // discriminating-terms rule and it must not clear the floor.
    await put("b", "Some unrelated work in mono", "nothing to see");
    const result = await runPickup({ index, admission: admitAll }, {
      message: "investigate the pagination regression",
      repositorySlug: "Jinn-Network/mono",
    });
    expect(result.terms).toContain("mono");
    expect(result.status).toBe("nothing-relevant");
  });

  test("plane and budget options are threaded through", async () => {
    await put("a", "Rebuild the flaky corpus index", "yarn rebuild --force");
    const publicOnly = await runPickup({ index, admission: admitAll }, {
      message: "flaky corpus index rebuild",
      planes: ["public"],
    });
    expect(publicOnly.status).toBe("nothing-relevant");

    const budgeted = await runPickup({ index, admission: admitAll }, {
      message: "flaky corpus index rebuild",
      budget: { maxRecords: 1, maxChars: 500 },
    });
    expect(budgeted.budget).toEqual({ maxChars: 500, maxRecords: 1 });
  });

  test("an empty message is answered honestly, not with a random record", async () => {
    await put("a", "Rebuild the flaky corpus index", "yarn rebuild --force");
    const result = await runPickup({ index, admission: admitAll }, { message: "   " });
    expect(result.status).toBe("nothing-relevant");
    expect(result.terms).toEqual([]);
  });

  test("an admission-rejecting policy empties the selection even when the index is populated", async () => {
    // The ruling's case: the index still holds records admitted under an earlier policy.
    // Ranking finds them; admission is asked again on the way into context and says no.
    await putPublic("p", "Rebuild the flaky corpus index", "yarn rebuild --force");

    const admitted = await runPickup(
      { index, admission: admitAll },
      { message: "flaky corpus index rebuild" },
    );
    expect(admitted.status).toBe("projected");

    const rejected = await runPickup(
      {
        index,
        admission: createCorpusAdmissionFilter({
          admitProducer: async () => ({ admitted: false }),
        }),
      },
      { message: "flaky corpus index rebuild" },
    );
    expect(rejected.status).toBe("nothing-relevant");
    expect(rejected.records).toEqual([]);
    expect(rejected.text).toBe("");
    // The index is untouched: admission gates the path into context, it does not evict.
    expect(index.has("public", { family: "execution-evidence", digest: digest("p") })).toBe(true);
  });

  test("a rejected producer does not suppress an admissible one", async () => {
    await putPublic("p", "Rebuild the flaky corpus index", "", "urn:jinn:agent:blocked");
    await putPublic("q", "Rebuild the flaky corpus index tokenizer", "", "urn:jinn:agent:ok");

    const result = await runPickup(
      {
        index,
        admission: createCorpusAdmissionFilter({
          admitProducer: async (producerId: string) => ({
            admitted: producerId !== "urn:jinn:agent:blocked",
          }),
        }),
      },
      { message: "flaky corpus index rebuild" },
    );
    expect(result.status).toBe("projected");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.origin).toBe("urn:jinn:agent:ok");
  });

  test("local-plane results are unaffected by a rejecting policy", async () => {
    await put("a", "Rebuild the flaky corpus index", "yarn rebuild --force");
    const result = await runPickup(
      {
        index,
        admission: createCorpusAdmissionFilter({
          admitProducer: async () => ({ admitted: false }),
        }),
      },
      { message: "flaky corpus index rebuild" },
    );
    expect(result.status).toBe("projected");
    expect(result.records[0]!.plane).toBe("local");
  });
});
