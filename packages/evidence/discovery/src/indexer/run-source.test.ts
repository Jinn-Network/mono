// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import type {
  AnnouncementBatch,
  EvidenceIndexerCheckpointStore,
  EvidenceRecordAnnouncementSource,
} from "../catalog/index.js";
import { InMemoryEvidenceCatalog } from "../catalog/index.js";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test, vi } from "vitest";

import type {
  EvidenceIndexer,
  EvidenceIndexingResult,
} from "./index-announcement.js";
import { createEvidenceIndexer } from "./index-announcement.js";
import { runEvidenceAnnouncementSource } from "./run-source.js";

const reference = {
  family: "execution-evidence",
  digest: `sha256:${"1".repeat(64)}`,
} as const;

function source(
  batches: readonly AnnouncementBatch[],
): EvidenceRecordAnnouncementSource & {
  readonly after: string[];
} {
  const after: string[] = [];
  return {
    after,
    async *read(options) {
      after.push(options?.after ?? "<beginning>");
      yield* batches;
    },
  };
}

function checkpoints(initial?: string): EvidenceIndexerCheckpointStore & {
  readonly writes: string[];
} {
  let cursor = initial;
  const writes: string[] = [];
  return {
    writes,
    async get() {
      return cursor;
    },
    async put(_sourceId, next) {
      cursor = next;
      writes.push(next);
    },
  };
}

function available(id: string) {
  return {
    kind: "available",
    sourceId: "source",
    announcementId: id,
    repositoryId: "repository",
    reference,
  } as const;
}

describe("announcement source replay", () => {
  test("starts from the beginning when no checkpoint exists", async () => {
    const announcementSource = source([]);
    await runEvidenceAnnouncementSource({
      sourceId: "source",
      source: announcementSource,
      indexer: { index: vi.fn() as never },
      checkpoints: checkpoints(),
    });
    expect(announcementSource.after).toEqual(["<beginning>"]);
  });

  test("starts at the stored cursor and processes batches sequentially", async () => {
    const events = [available("a1"), available("a2")];
    const batches = [
      { announcements: [events[0]!], cursor: "c2" },
      { announcements: [events[1]!], cursor: "c3" },
    ];
    const announcementSource = source(batches);
    const checkpointStore = checkpoints("c1");
    const order: string[] = [];
    const indexer: EvidenceIndexer = {
      async index(announcement) {
        order.push(announcement.announcementId);
        return {
          status: "indexed",
          reference,
          projectionStatus: "existing",
          locationStatus: "existing",
        };
      },
    };
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: announcementSource,
        indexer,
        checkpoints: checkpointStore,
      }),
    ).resolves.toEqual({
      batches: 2,
      announcements: 2,
      indexed: 2,
      rejected: 0,
      withdrawn: 0,
      finalCursor: "c3",
    });
    expect(announcementSource.after).toEqual(["c1"]);
    expect(order).toEqual(["a1", "a2"]);
    expect(checkpointStore.writes).toEqual(["c2", "c3"]);
  });

  test("checkpoints terminal rejection and withdrawal results", async () => {
    const announcementSource = source([
      {
        announcements: [
          available("rejected"),
          {
            kind: "withdrawn",
            sourceId: "source",
            announcementId: "withdrawn",
            retractsAnnouncementId: "rejected",
          },
        ],
        cursor: "terminal",
      },
    ]);
    const results: EvidenceIndexingResult[] = [
      {
        status: "rejected",
        reference,
        diagnostics: [
          { code: "JSON_INVALID", path: "/", message: "Fixture invalid." },
        ],
      },
      { status: "withdrawn", locationStatus: "absent" },
    ];
    const indexer: EvidenceIndexer = {
      index: vi.fn(async () => results.shift()!),
    };
    const checkpointStore = checkpoints();
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: announcementSource,
        indexer,
        checkpoints: checkpointStore,
      }),
    ).resolves.toMatchObject({ rejected: 1, withdrawn: 1 });
    expect(checkpointStore.writes).toEqual(["terminal"]);
  });

  test.each(["indexer", "callback"] as const)(
    "does not checkpoint after a %s failure",
    async (failureAt) => {
      const expected = new Error(`Fixture ${failureAt} failure.`);
      const checkpointStore = checkpoints();
      const indexer: EvidenceIndexer = {
        async index() {
          if (failureAt === "indexer") throw expected;
          return {
            status: "indexed",
            reference,
            projectionStatus: "created",
            locationStatus: "created",
          };
        },
      };
      await expect(
        runEvidenceAnnouncementSource({
          sourceId: "source",
          source: source([
            { announcements: [available("a1")], cursor: "uncommitted" },
          ]),
          indexer,
          checkpoints: checkpointStore,
          ...(failureAt === "callback"
            ? {
                onResult: () => {
                  throw expected;
                },
              }
            : {}),
        }),
      ).rejects.toBe(expected);
      expect(checkpointStore.writes).toEqual([]);
    },
  );

  test("rejects mismatched source identity before checkpointing", async () => {
    const checkpointStore = checkpoints();
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "configured",
        source: source([
          { announcements: [available("a1")], cursor: "uncommitted" },
        ]),
        indexer: {
          index: vi.fn() as never,
        },
        checkpoints: checkpointStore,
      }),
    ).rejects.toMatchObject({ code: "ANNOUNCEMENT_INVALID" });
    expect(checkpointStore.writes).toEqual([]);
  });

  test("does not checkpoint after cancellation", async () => {
    const controller = new AbortController();
    const checkpointStore = checkpoints();
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: source([
          { announcements: [available("a1")], cursor: "uncommitted" },
        ]),
        indexer: {
          async index() {
            controller.abort();
            return {
              status: "indexed",
              reference,
              projectionStatus: "created",
              locationStatus: "created",
            };
          },
        },
        checkpoints: checkpointStore,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(checkpointStore.writes).toEqual([]);
  });

  test("treats a resolved checkpoint write as committed before later cancellation", async () => {
    const controller = new AbortController();
    const writes: string[] = [];
    await expect(runEvidenceAnnouncementSource({
      sourceId: "source",
      source: source([
        { announcements: [available("a1")], cursor: "committed" },
      ]),
      indexer: {
        async index() {
          return {
            status: "indexed",
            reference,
            projectionStatus: "created",
            locationStatus: "created",
          };
        },
      },
      checkpoints: {
        async get() {
          return undefined;
        },
        async put(_sourceId, cursor) {
          writes.push(cursor);
          controller.abort();
        },
      },
      signal: controller.signal,
    })).resolves.toMatchObject({
      batches: 1,
      finalCursor: "committed",
    });
    expect(writes).toEqual(["committed"]);
  });

  test("snapshots a dense batch and cursor before indexing awaits", async () => {
    const batch = {
      announcements: [available("a1"), available("a2")],
      cursor: "original",
    };
    const processed: string[] = [];
    const checkpointStore = checkpoints();
    await runEvidenceAnnouncementSource({
      sourceId: "source",
      source: source([batch]),
      indexer: {
        async index(announcement) {
          processed.push(announcement.announcementId);
          if (processed.length === 1) {
            batch.announcements.splice(1);
            batch.cursor = "mutated";
            await Promise.resolve();
          }
          return {
            status: "indexed",
            reference,
            projectionStatus: "created",
            locationStatus: "created",
          };
        },
      },
      checkpoints: checkpointStore,
    });
    expect(processed).toEqual(["a1", "a2"]);
    expect(checkpointStore.writes).toEqual(["original"]);
  });

  test("rejects sparse or getter-backed batches with stable identity", async () => {
    const sparse = Array(1) as never;
    for (const batch of [
      { announcements: sparse, cursor: "cursor" },
      Object.defineProperty({}, "announcements", {
        enumerable: true,
        get: () => [],
      }),
    ]) {
      await expect(runEvidenceAnnouncementSource({
        sourceId: "source",
        source: source([batch as never]),
        indexer: { index: vi.fn() as never },
        checkpoints: checkpoints(),
      })).rejects.toMatchObject({ code: "ANNOUNCEMENT_INVALID" });
    }
  });

  test("replays already-written events after a callback crash", async () => {
    let existing = false;
    const indexer: EvidenceIndexer = {
      async index() {
        const status = existing ? "existing" : "created";
        existing = true;
        return {
          status: "indexed",
          reference,
          projectionStatus: status,
          locationStatus: status,
        };
      },
    };
    const batch = { announcements: [available("a1")], cursor: "committed" };
    const checkpointStore = checkpoints();
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: source([batch]),
        indexer,
        checkpoints: checkpointStore,
        onResult: () => {
          throw new Error("Fixture callback crash.");
        },
      }),
    ).rejects.toThrow("Fixture callback crash.");
    expect(checkpointStore.writes).toEqual([]);
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: source([batch]),
        indexer,
        checkpoints: checkpointStore,
      }),
    ).resolves.toMatchObject({ indexed: 1, finalCursor: "committed" });
    expect(checkpointStore.writes).toEqual(["committed"]);
  });

  test("rebuilds four record-scoped projections from golden replay", async () => {
    const fixtureRoot = new URL(
      ".",
      import.meta.resolve(
        "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
      ),
    );
    const paths = {
      private: "execution/ro-crate-metadata.json",
      public: "public/ro-crate-metadata.json",
      evaluation:
        "claims/result-evaluation/result-evaluation.dsse.json",
      verification:
        "claims/execution-verification/execution-verification.dsse.json",
    } as const;
    const bytes = Object.fromEntries(
      await Promise.all(
        Object.entries(paths).map(async ([name, relativePath]) => [
          name,
          await readFile(new URL(relativePath, fixtureRoot)),
        ]),
      ),
    ) as Record<keyof typeof paths, Uint8Array>;
    const privateRepository = new InMemoryEvidenceRepository();
    const publicRepository = new InMemoryEvidenceRepository();
    const privateReference = (
      await privateRepository.putRecord("execution-evidence", bytes.private)
    ).reference;
    const publicReference = (
      await publicRepository.putRecord("execution-evidence", bytes.public)
    ).reference;
    const evaluationReference = (
      await privateRepository.putRecord("result-evaluation", bytes.evaluation)
    ).reference;
    const verificationReference = (
      await privateRepository.putRecord(
        "execution-verification",
        bytes.verification,
      )
    ).reference;
    const catalog = new InMemoryEvidenceCatalog();
    const indexer = createEvidenceIndexer({
      repositories: {
        async resolve(repositoryId) {
          if (repositoryId === "private") return privateRepository;
          if (repositoryId === "public") return publicRepository;
          return null;
        },
      },
      catalog,
    });
    const announcements = [
      {
        kind: "available",
        sourceId: "source",
        announcementId: "private",
        repositoryId: "private",
        reference: privateReference,
      },
      {
        kind: "available",
        sourceId: "source",
        announcementId: "public",
        repositoryId: "public",
        reference: publicReference,
      },
      {
        kind: "available",
        sourceId: "source",
        announcementId: "evaluation",
        repositoryId: "private",
        reference: evaluationReference,
      },
      {
        kind: "available",
        sourceId: "source",
        announcementId: "verification",
        repositoryId: "private",
        reference: verificationReference,
      },
      {
        kind: "withdrawn",
        sourceId: "source",
        announcementId: "private-withdrawn",
        retractsAnnouncementId: "private",
      },
    ] as const;
    const checkpointStore = checkpoints();
    await expect(
      runEvidenceAnnouncementSource({
        sourceId: "source",
        source: source([
          { announcements, cursor: "first" },
          { announcements, cursor: "replayed" },
        ]),
        indexer,
        checkpoints: checkpointStore,
      }),
    ).resolves.toEqual({
      batches: 2,
      announcements: 10,
      indexed: 8,
      rejected: 0,
      withdrawn: 2,
      finalCursor: "replayed",
    });
    const executions = await catalog.findExecutions({ availability: "any" });
    expect(executions.items).toHaveLength(2);
    expect(new Set(executions.items.map(({ executionId }) => executionId)).size)
      .toBe(1);
    expect((await catalog.findExecutions({})).items).toEqual([
      expect.objectContaining({ reference: publicReference }),
    ]);
    expect((await catalog.findEvaluations({})).items).toHaveLength(1);
    expect((await catalog.findVerifications({})).items).toHaveLength(1);
    expect(await catalog.getRecordLocations(privateReference)).toEqual([]);
    expect(await catalog.getRecordLocations(publicReference)).toEqual([
      { repositoryId: "public" },
    ]);
  });
});
