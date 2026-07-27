// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import {
  EvidenceCatalogError,
  InMemoryEvidenceCatalog,
  type EvidenceCatalogWriter,
  type EvidenceRepositoryResolver,
} from "@jinn-network/evidence-catalog";
import {
  EvidenceRepositoryError,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test, vi } from "vitest";

import { createEvidenceIndexer } from "./index-announcement.js";
import * as publicApi from "./index.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

async function fixture(relativePath: string): Promise<Uint8Array> {
  return readFile(new URL(relativePath, fixtureRoot));
}

function resolver(
  repository: InMemoryEvidenceRepository | null,
): EvidenceRepositoryResolver {
  return { resolve: vi.fn(async () => repository) };
}

describe("single announcement indexing", () => {
  test("does not expose internal snapshotting at the package root", () => {
    expect(publicApi).not.toHaveProperty("snapshotEvidenceRecordAnnouncement");
  });

  test.each([
    ["execution-evidence", "execution/ro-crate-metadata.json"],
    [
      "result-evaluation",
      "claims/result-evaluation/result-evaluation.dsse.json",
    ],
    [
      "execution-verification",
      "claims/execution-verification/execution-verification.dsse.json",
    ],
  ] as const)("indexes an available %s record", async (family, path) => {
    const repository = new InMemoryEvidenceRepository();
    const bytes = await fixture(path);
    const stored = await repository.putRecord(family, bytes);
    const catalog = new InMemoryEvidenceCatalog();
    const indexer = createEvidenceIndexer({
      repositories: resolver(repository),
      catalog,
    });

    await expect(
      indexer.index({
        kind: "available",
        sourceId: "source",
        announcementId: `available-${family}`,
        repositoryId: "repository",
        reference: stored.reference,
      }),
    ).resolves.toMatchObject({
      status: "indexed",
      projectionStatus: "created",
      locationStatus: "created",
    });
    expect(await catalog.getRecord(stored.reference)).not.toBeNull();
    expect(await catalog.getRecordLocations(stored.reference)).toEqual([
      { repositoryId: "repository" },
    ]);
  });

  test("rejects nonconforming bytes without Catalog writes", async () => {
    const repository = new InMemoryEvidenceRepository();
    const stored = await repository.putRecord(
      "result-evaluation",
      Buffer.from("{"),
    );
    const catalog = new InMemoryEvidenceCatalog();
    const result = await createEvidenceIndexer({
      repositories: resolver(repository),
      catalog,
    }).index({
      kind: "available",
      sourceId: "source",
      announcementId: "invalid",
      repositoryId: "repository",
      reference: stored.reference,
    });
    expect(result).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "JSON_INVALID" }],
    });
    expect(await catalog.getRecord(stored.reference)).toBeNull();
  });

  test("classifies missing repositories and records", async () => {
    const bytes = Buffer.from("missing");
    const repository = new InMemoryEvidenceRepository();
    const reference = (await repository.putRecord("execution-evidence", bytes))
      .reference;
    for (const [configured, code] of [
      [null, "REPOSITORY_NOT_CONFIGURED"],
      [new InMemoryEvidenceRepository(), "RECORD_UNAVAILABLE"],
    ] as const) {
      await expect(
        createEvidenceIndexer({
          repositories: resolver(configured),
          catalog: new InMemoryEvidenceCatalog(),
        }).index({
          kind: "available",
          sourceId: "source",
          announcementId: code,
          repositoryId: "repository",
          reference,
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  test("withdraws without resolving or retrieving a repository", async () => {
    const repositories = resolver(null);
    const catalog = new InMemoryEvidenceCatalog();
    const result = await createEvidenceIndexer({
      repositories,
      catalog,
    }).index({
      kind: "withdrawn",
      sourceId: "source",
      announcementId: "withdrawal",
      retractsAnnouncementId: "missing",
    });
    expect(result).toEqual({ status: "withdrawn", locationStatus: "absent" });
    expect(repositories.resolve).not.toHaveBeenCalled();
  });

  test.each([
    {
      kind: "not-an-announcement-kind",
      sourceId: "source",
      announcementId: "invalid-kind",
    },
    {
      kind: "available",
      sourceId: "source",
      announcementId: "secret-field",
      repositoryId: "repository",
      reference: {
        family: "execution-evidence",
        digest: `sha256:${"0".repeat(64)}`,
      },
      publishedLocation: {
        bindingProfile: "https://example.invalid/binding",
        locator: { object: "fixture" },
        authToken: "must-not-enter-the-catalog",
      },
    },
  ])("rejects malformed or out-of-contract announcements %#", async (announcement) => {
    const repositories = resolver(null);
    const catalog = new InMemoryEvidenceCatalog();
    await expect(createEvidenceIndexer({
      repositories,
      catalog,
    }).index(announcement as never)).rejects.toMatchObject({
      code: "ANNOUNCEMENT_INVALID",
    });
    expect(repositories.resolve).not.toHaveBeenCalled();
  });

  test("recovers after projection succeeds and the first location write fails", async () => {
    const repository = new InMemoryEvidenceRepository();
    const bytes = await fixture("execution/ro-crate-metadata.json");
    const stored = await repository.putRecord("execution-evidence", bytes);
    const catalog = new InMemoryEvidenceCatalog();
    let fail = true;
    const writer: EvidenceCatalogWriter = {
      putRecordProjection: (...args) => catalog.putRecordProjection(...args),
      withdrawRecordLocationObservation: (...args) =>
        catalog.withdrawRecordLocationObservation(...args),
      observeRecordLocation: async (...args) => {
        if (fail) {
          fail = false;
          throw new EvidenceCatalogError(
            "IO_FAILURE",
            "Fixture location failure.",
          );
        }
        return catalog.observeRecordLocation(...args);
      },
    };
    const indexer = createEvidenceIndexer({
      repositories: resolver(repository),
      catalog: writer,
    });
    const announcement = {
      kind: "available",
      sourceId: "source",
      announcementId: "available",
      repositoryId: "repository",
      reference: stored.reference,
    } as const;
    await expect(indexer.index(announcement)).rejects.toMatchObject({
      code: "IO_FAILURE",
    });
    await expect(indexer.index(announcement)).resolves.toMatchObject({
      projectionStatus: "existing",
      locationStatus: "created",
    });
    expect(await catalog.getRecordLocations(stored.reference)).toHaveLength(1);
  });

  test("preserves Repository and Catalog error object identity", async () => {
    const repositoryFailure = new EvidenceRepositoryError(
      "ACCESS_DENIED",
      "Fixture access denied.",
    );
    const repository = {
      getRecord: vi.fn(async () => {
        throw repositoryFailure;
      }),
    } as never;
    const indexer = createEvidenceIndexer({
      repositories: resolver(repository),
      catalog: new InMemoryEvidenceCatalog(),
    });
    const reference = {
      family: "execution-evidence",
      digest: `sha256:${"0".repeat(64)}`,
    } as const;
    await expect(
      indexer.index({
        kind: "available",
        sourceId: "source",
        announcementId: "access",
        repositoryId: "repository",
        reference,
      }),
    ).rejects.toBe(repositoryFailure);

    const catalogFailure = new EvidenceCatalogError(
      "IO_FAILURE",
      "Fixture Catalog failure.",
    );
    const writer = {
      withdrawRecordLocationObservation: vi.fn(async () => {
        throw catalogFailure;
      }),
    } as never;
    await expect(
      createEvidenceIndexer({
        repositories: resolver(null),
        catalog: writer,
      }).index({
        kind: "withdrawn",
        sourceId: "source",
        announcementId: "withdraw",
        retractsAnnouncementId: "available",
      }),
    ).rejects.toBe(catalogFailure);
  });

  test("preserves a Catalog projection-conflict error by identity", async () => {
    const repository = new InMemoryEvidenceRepository();
    const bytes = await fixture("execution/ro-crate-metadata.json");
    const stored = await repository.putRecord("execution-evidence", bytes);
    const conflict = new EvidenceCatalogError(
      "PROJECTION_CONFLICT",
      "Fixture projection conflict.",
    );
    const catalog = {
      putRecordProjection: vi.fn(async () => {
        throw conflict;
      }),
    } as never;
    await expect(
      createEvidenceIndexer({
        repositories: resolver(repository),
        catalog,
      }).index({
        kind: "available",
        sourceId: "source",
        announcementId: "conflict",
        repositoryId: "repository",
        reference: stored.reference,
      }),
    ).rejects.toBe(conflict);
  });

  test("independently rejects corrupt retrieved bytes and never fetches artifacts", async () => {
    const expectedBytes = Buffer.from("expected");
    const corruptBytes = Buffer.from("corrupt");
    const seed = new InMemoryEvidenceRepository();
    const reference = (
      await seed.putRecord("execution-evidence", expectedBytes)
    ).reference;
    const getArtifact = vi.fn();
    const repository = {
      getRecord: vi.fn(async () => corruptBytes),
      getArtifact,
    } as never;
    await expect(
      createEvidenceIndexer({
        repositories: resolver(repository),
        catalog: new InMemoryEvidenceCatalog(),
      }).index({
        kind: "available",
        sourceId: "source",
        announcementId: "corrupt",
        repositoryId: "repository",
        reference,
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_MISMATCH" });
    expect(getArtifact).not.toHaveBeenCalled();
  });

  test("honors already-aborted operations", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createEvidenceIndexer({
        repositories: resolver(null),
        catalog: new InMemoryEvidenceCatalog(),
      }).index(
        {
          kind: "withdrawn",
          sourceId: "source",
          announcementId: "withdraw",
          retractsAnnouncementId: "available",
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
