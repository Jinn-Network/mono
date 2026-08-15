// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../capture/paths.js";
import { type IndexDatabaseIO } from "./database.js";
import { indexLocalPlane, indexPublicPlane, rebuildIndex } from "./indexing.js";
import { openRelevanceIndex, type RelevanceIndex } from "./index-store.js";
import { type SensitivityNonceIO } from "./nonce.js";
import { createSensitivityClassifier } from "./sensitivity.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

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

const projection = (seed: string) => ({
  family: "execution-evidence" as const,
  reference: { family: "execution-evidence" as const, digest: digest(seed) },
  byteSize: 10,
  declaredEntities: [],
  declaredRelationships: [],
  executionId: `urn:uuid:0000-${seed}`,
  task: { entityId: "task.json", digest: digest("t") },
  executorId: "urn:jinn:agent:local",
  runtime: { entityId: "runtime.json", digest: digest("r") },
  results: [],
  nativeTrace: { entityId: "feed.ndjson", digest: digest("n") },
  outcome: "completed" as const,
  startedAt: "2026-07-12T09:00:00.000Z",
  endedAt: "2026-07-12T09:05:00.000Z",
  publishedAt: "2026-07-12T09:05:01.000Z",
});

const artifactBytes = new Map<string, Uint8Array>([
  [digest("t"), encode('{"summary":"Rebuild the flaky corpus index"}')],
  [digest("n"), encode(JSON.stringify({ command: "yarn rebuild", result: "ok" }))],
]);

const closeSpy = vi.fn();

const fakeRuntime = () => ({
  repository: {
    getRecord: async () => encode("{}"),
    getArtifact: async (reference: { digest: string }) =>
      artifactBytes.get(reference.digest) ?? null,
  },
  catalog: {
    findExecutions: async (query: { cursor?: string }) =>
      query.cursor === undefined
        ? { items: [projection("a")], nextCursor: "page-2" }
        : { items: [projection("b")] },
  },
  close: async () => {
    closeSpy();
  },
});

let index: RelevanceIndex;

beforeEach(async () => {
  closeSpy.mockClear();
  const home = await mkdtemp(join(tmpdir(), "jinn-indexing-"));
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

const deps = () => ({
  index,
  spanSource: { spansFor: () => [] },
  openLocalRuntime: async () => fakeRuntime() as never,
});

describe("indexing orchestration", () => {
  test("walks every catalog page and indexes each record", async () => {
    const report = await indexLocalPlane(deps());
    expect(report.indexed).toBe(2);
    expect(index.has("local", { family: "execution-evidence", digest: digest("a") })).toBe(true);
    expect(index.has("local", { family: "execution-evidence", digest: digest("b") })).toBe(true);
  });

  test("the archive is always closed, including on failure", async () => {
    await indexLocalPlane(deps());
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const exploding = {
      ...deps(),
      openLocalRuntime: async () =>
        ({
          ...fakeRuntime(),
          catalog: {
            findExecutions: async () => {
              throw new Error("catalog exploded");
            },
          },
        }) as never,
    };
    await expect(indexLocalPlane(exploding)).rejects.toThrow("catalog exploded");
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test("the local summary comes from the task artifact", async () => {
    await indexLocalPlane(deps());
    const [hit] = await index.search({ terms: ["flaky", "corpus"], planes: ["local"] });
    expect(hit!.summary).toBe("Rebuild the flaky corpus index");
    expect(hit!.origin).toBe("urn:jinn:agent:local");
    expect(hit!.capturedAt).toBe("2026-07-12T09:00:00.000Z");
  });

  test("a record whose task artifact is missing is skipped, not indexed empty", async () => {
    const missing = {
      ...deps(),
      openLocalRuntime: async () =>
        ({ ...fakeRuntime(), repository: { getRecord: async () => encode("{}"), getArtifact: async () => null } }) as never,
    };
    const report = await indexLocalPlane(missing);
    expect(report.indexed).toBe(0);
    expect(report.skipped).toBe(2);
  });

  test("the public plane pages through the corpus reader and carries trust exclusions", async () => {
    const report = await indexPublicPlane({
      ...deps(),
      corpusReader: {
        listRecords: async (query?: { cursor?: string }) =>
          query?.cursor === undefined
            ? { items: [{ reference: projection("p").reference, projection: projection("p"), plane: "public", locationHints: [] }], nextCursor: undefined, excludedByTrust: 3 }
            : { items: [], excludedByTrust: 0 },
      } as never,
      corpusRetrieval: {
        fetchRecord: async () => ({
          status: "fetched",
          result: {
            reference: projection("p").reference,
            canonicalBytes: encode("{}"),
            validatedRecord: { family: "execution-evidence", value: {} },
            discoveryProvenance: [],
            availability: [],
            artifacts: [
              {
                declaration: { entityId: "task.json", reference: { digest: digest("t") }, roles: ["task"] },
                status: "verified",
                bytes: artifactBytes.get(digest("t"))!,
              },
            ],
            completeness: "complete",
            warnings: [],
          },
        }),
      } as never,
    });
    expect(report.indexed).toBe(1);
    expect(report.excludedByTrust).toBe(3);
    expect(index.has("public", projection("p").reference)).toBe(true);
  });

  test("a failed public fetch is skipped, never fatal", async () => {
    const report = await indexPublicPlane({
      ...deps(),
      corpusReader: {
        listRecords: async () => ({
          items: [{ reference: projection("p").reference, projection: projection("p"), plane: "public", locationHints: [] }],
          excludedByTrust: 0,
        }),
      } as never,
      corpusRetrieval: {
        fetchRecord: async () => ({
          status: "failed",
          failure: { code: "NO_LOCATION", stage: "location", message: "gone", retryable: false },
        }),
      } as never,
    });
    expect(report.indexed).toBe(0);
    expect(report.skipped).toBe(1);
  });

  test("a rebuild with no corpus configured still indexes the local plane", async () => {
    const report = await rebuildIndex(deps());
    expect(report.indexed).toBe(2);
    expect(report.excludedByTrust).toBe(0);
  });

  test("the pass persists its trust exclusions where the doctor reads them", async () => {
    await indexPublicPlane({
      ...deps(),
      corpusReader: {
        listRecords: async () => ({ items: [], excludedByTrust: 4 }),
      } as never,
      corpusRetrieval: { fetchRecord: async () => ({ status: "failed", failure: {} }) } as never,
    });
    expect(index.stats().excludedByTrust).toBe(4);
  });

  test("a pass with no corpus configured clears a stale exclusion count", async () => {
    index.recordTrustExclusions(9);
    await indexPublicPlane(deps());
    expect(index.stats().excludedByTrust).toBe(0);
  });
});
