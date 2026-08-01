// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
} from "./admission.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import type { CorpusFilesystem } from "./fs.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import { createCorpusReader, producerIdOf } from "./read.js";
import { withCorpusMirrorStore } from "./store.js";
import {
  executionProjection,
  seedMirror,
  type SeededMirror,
} from "./testing-fixture.js";

const corpusFs = createNodeCorpusFilesystem();

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const ALICE = "https://agents.test/alice";
const MALLORY = "https://agents.test/mallory";

function admitting(...producers: readonly string[]) {
  return composeAdmission(createFollowedSourceAdmission([source]), {
    admitSource: () => ({ status: "admitted" as const }),
    admitProducer: (id: string) =>
      producers.includes(id)
        ? ({ status: "admitted" } as const)
        : ({ status: "rejected", reason: "producer-not-listed" } as const),
  });
}

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string; fs: CorpusFilesystem };
let statePath: string;
let seeded: SeededMirror;

function reader(admission = admitting(ALICE)) {
  return createCorpusReader({
    storePaths: paths,
    sources: [source],
    admission,
    highWaterMarks: createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs }),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-read-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
    fs: corpusFs,
  };
  statePath = join(directory, "mirror-state.json");
  // Seeds three execution records: two by ALICE, one by MALLORY.
  seeded = await seedMirror(paths, source);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("producer identity", () => {
  test("reads the producer from whichever family the projection is", () => {
    expect(producerIdOf(executionProjection({ executorId: ALICE }))).toBe(ALICE);
  });
});

describe("corpus reader — the C6 seam", () => {
  test("STRUCTURAL: the reader exposes no sync method and holds no mirror", () => {
    const instance = reader();
    // @ts-expect-error — `CorpusReader` deliberately has no `syncOnce`.
    expect(instance.syncOnce).toBeUndefined();
    expect(Object.keys(instance).sort()).toEqual(["describeSources", "getRecord", "listRecords"]);
  });

  test("serves the current mirror while a sync lock is held elsewhere", async () => {
    const held = await tryAcquireSyncLock({ path: join(directory, "mirror-sync.lock"), fs: corpusFs });
    try {
      const started = Date.now();
      const page = await reader().listRecords();
      expect(page.items.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await held!.close();
    }
  });

  test("TRUST: an unadmitted producer's records never appear", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => producerIdOf(item.projection) === ALICE)).toBe(true);
    expect(page.excludedByTrust).toBe(1);
  });

  test("TRUST: a fully denying admission yields an empty page, and work proceeds", async () => {
    const page = await reader(
      composeAdmission(createFollowedSourceAdmission([source]), createDeniedProducerAdmission()),
    ).listRecords({ limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.excludedByTrust).toBe(3);
    // Fail-open on absence: an empty page is a value, not a throw.
  });

  test("distinguishes a filtered empty page from an honestly empty one", async () => {
    await withCorpusMirrorStore(paths, async () => undefined);
    const filtered = await reader(
      composeAdmission(createFollowedSourceAdmission([source]), createDeniedProducerAdmission()),
    ).listRecords({ limit: 10 });
    const honest = await reader(admitting(ALICE)).listRecords({ limit: 10, executorId: "nobody" });
    expect(filtered.excludedByTrust).toBeGreaterThan(0);
    expect(honest.excludedByTrust).toBe(0);
    expect(honest.items).toEqual([]);
  });

  test("NO RANKING: items are returned in catalog order, unreordered", async () => {
    const page = await reader().listRecords({ limit: 10 });
    const catalogOrder = await withCorpusMirrorStore(paths, async (store) =>
      (await store.catalog.findExecutions({ limit: 10, availability: "available" })).items
        .filter((item) => item.executorId === ALICE)
        .map((item) => item.reference.digest),
    );
    expect(page.items.map((item) => item.reference.digest)).toEqual(catalogOrder);
  });

  test("tags every candidate with the public plane", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items.every((item) => item.plane === "public")).toBe(true);
  });

  test("carries location hints derived from the catalog's observed locations", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items[0]!.locationHints[0]).toMatchObject({
      sourceId: "https://agents.test/alice/attempts",
      repositoryId: "archive.test/attempts",
    });
  });

  test("pages with an opaque cursor until it is exhausted", async () => {
    const instance = reader();
    const first = await instance.listRecords({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await instance.listRecords({ limit: 1, cursor: first.nextCursor });
    expect(second.items[0]!.reference.digest).not.toBe(first.items[0]!.reference.digest);
  });

  test("getRecord returns null for an unadmitted producer, not the record", async () => {
    expect(await reader().getRecord(seeded.malloryReference)).toBeNull();
    expect(await reader().getRecord(seeded.aliceReferences[0]!)).not.toBeNull();
  });

  test("getRecord returns null for a record that is not mirrored", async () => {
    expect(
      await reader().getRecord({ family: "execution-evidence", digest: `sha256:${"f".repeat(64)}` }),
    ).toBeNull();
  });

  test("describeSources reports the followed archives and their sync position", async () => {
    const marks = createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs });
    await marks.put(
      { agent: source.agent, name: source.name },
      { sequence: "0000000000000004", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );
    const statuses = await reader().describeSources();
    expect(statuses).toEqual([
      {
        source: { agent: source.agent, name: source.name },
        servingRoot: source.servingRoot,
        repositoryId: source.repositoryId,
        highWaterMark: {
          sequence: "0000000000000004",
          entry: `sha256:${"a".repeat(64)}`,
          issuedAt: "2026-07-30T00:00:00Z",
        },
      },
    ]);
  });

  test("describeSources omits the mark for an archive never synced", async () => {
    const statuses = await reader().describeSources();
    expect(statuses[0]).not.toHaveProperty("highWaterMark");
  });
});
