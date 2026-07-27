// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";

import { InMemoryEvidenceCatalog } from "./in-memory.js";
import { createCatalogContractFixtures } from "./testing.js";

describe("InMemoryEvidenceCatalog", () => {
  test("keeps source-scoped observations and withdrawals isolated", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await catalog.putRecordProjection(privateExecution);
    await catalog.observeRecordLocation(privateExecution.reference, {
      sourceId: "source-a",
      announcementId: "a1",
      repositoryId: "local",
    });
    await catalog.observeRecordLocation(privateExecution.reference, {
      sourceId: "source-b",
      announcementId: "b1",
      repositoryId: "local",
    });

    await expect(
      catalog.withdrawRecordLocationObservation({
        sourceId: "source-a",
        announcementId: "a2",
        retractsAnnouncementId: "b1",
      }),
    ).rejects.toMatchObject({ code: "LOCATION_CONFLICT" });

    await catalog.withdrawRecordLocationObservation({
      sourceId: "source-a",
      announcementId: "a3",
      retractsAnnouncementId: "a1",
    });
    expect(await catalog.getRecordLocations(privateExecution.reference)).toEqual([
      { repositoryId: "local" },
    ]);
  });

  test("rejects non-finite published locator values", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await catalog.putRecordProjection(privateExecution);
    await expect(
      catalog.observeRecordLocation(privateExecution.reference, {
        sourceId: "source",
        announcementId: "a1",
        repositoryId: "repository",
        publishedLocation: {
          bindingProfile: "https://example.invalid/binding",
          locator: { invalid: Number.POSITIVE_INFINITY },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
  });

  test("rejects unsafe or cyclic locator objects", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await catalog.putRecordProjection(privateExecution);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const locator of [new Date(), cyclic]) {
      await expect(
        catalog.observeRecordLocation(privateExecution.reference, {
          sourceId: "source",
          announcementId: `a-${String(locator)}`,
          repositoryId: "repository",
          publishedLocation: {
            bindingProfile: "https://example.invalid/binding",
            locator: locator as never,
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    }
  });

  test("converts malformed projection structures into Catalog errors", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    const malformed = [
      { ...privateExecution, results: undefined },
      { ...privateExecution, declaredEntities: null },
      { ...privateExecution, task: new Date() },
    ];
    for (const projection of malformed) {
      await expect(
        catalog.putRecordProjection(projection as never),
      ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    }
  });

  test.each(["failed", "abandoned"] as const)(
    "accepts a %s Execution without Results",
    async (outcome) => {
      const catalog = new InMemoryEvidenceCatalog();
      const { privateExecution } = createCatalogContractFixtures();
      const projection = {
        ...privateExecution,
        outcome,
        results: [],
      };
      await expect(catalog.putRecordProjection(projection)).resolves.toMatchObject({
        status: "created",
      });
      await expect(catalog.getRecord(projection.reference)).resolves.toEqual(
        projection,
      );
    },
  );

  test("requires a completed Execution to declare a Result", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await expect(
      catalog.putRecordProjection({
        ...privateExecution,
        results: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
  });

  test("rejects fields outside the frozen record-scoped projection schema", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    for (const projection of [
      { ...privateExecution, trustScore: 1 },
      {
        ...privateExecution,
        task: { ...privateExecution.task, privateRepositoryPath: "/private" },
      },
      {
        ...privateExecution,
        declaredEntities: [{
          ...privateExecution.declaredEntities[0]!,
          corpusMembership: true,
        }],
      },
      {
        ...privateExecution,
        results: Object.assign([...privateExecution.results], {
          "4294967295": { trustScore: 1 },
        }),
      },
    ]) {
      await expect(catalog.putRecordProjection(projection as never))
        .rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    }
  });

  test("uses injective source and announcement identity keys", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await catalog.putRecordProjection(privateExecution);
    await catalog.observeRecordLocation(privateExecution.reference, {
      sourceId: "a\0b",
      announcementId: "c",
      repositoryId: "repository",
    });
    await expect(catalog.withdrawRecordLocationObservation({
      sourceId: "a",
      announcementId: "withdrawal",
      retractsAnnouncementId: "b\0c",
    })).resolves.toEqual({ status: "absent" });
    expect(await catalog.getRecordLocations(privateExecution.reference)).toEqual([
      { repositoryId: "repository" },
    ]);
  });

  test("selects portable-location representatives independent of replay order", async () => {
    const { privateExecution } = createCatalogContractFixtures();
    const build = async (repositoryIds: readonly string[]) => {
      const catalog = new InMemoryEvidenceCatalog();
      await catalog.putRecordProjection(privateExecution);
      for (const repositoryId of repositoryIds) {
        await catalog.observeRecordLocation(privateExecution.reference, {
          sourceId: `source-${repositoryId}`,
          announcementId: "available",
          repositoryId,
          publishedLocation: {
            bindingProfile: "https://example.invalid/portable",
            locator: { digest: privateExecution.reference.digest },
          },
        });
      }
      return catalog.getRecordLocations(privateExecution.reference);
    };
    const expected = [{
      repositoryId: "repo-a",
      publishedLocation: {
        bindingProfile: "https://example.invalid/portable",
        locator: { digest: privateExecution.reference.digest },
      },
    }];
    await expect(build(["repo-a", "repo-b"])).resolves.toEqual(expected);
    await expect(build(["repo-b", "repo-a"])).resolves.toEqual(expected);
  });

  test("validates and snapshots record references before observation", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const { privateExecution } = createCatalogContractFixtures();
    await catalog.putRecordProjection(privateExecution);
    let digestReads = 0;
    const reference = {
      family: "execution-evidence",
      get digest() {
        digestReads += 1;
        return privateExecution.reference.digest;
      },
    };
    await expect(catalog.observeRecordLocation(reference as never, {
      sourceId: "source",
      announcementId: "available",
      repositoryId: "repository",
    })).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    expect(digestReads).toBe(0);
    expect(await catalog.getRecordLocations(privateExecution.reference)).toEqual([]);
  });

  test("classifies invalid entity queries as INVALID_QUERY", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    await expect(catalog.findRecordsForEntity("", {})).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  test("validates hostile reader queries before reading their fields", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const getterQuery = Object.defineProperty({}, "availability", {
      enumerable: true,
      get() {
        throw new Error("caller getter must not run");
      },
    });
    for (const operation of [
      () => catalog.findExecutions(null as never),
      () => catalog.findEvaluations(getterQuery as never),
      () => catalog.findVerifications(getterQuery as never),
      () => catalog.findRecordsForEntity("urn:entity", getterQuery as never),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "INVALID_QUERY",
      });
    }
  });

  test("validates hostile references on exact reader methods", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const hostile = Object.defineProperty(
      { family: "execution-evidence" },
      "digest",
      {
        enumerable: true,
        get() {
          throw new Error("caller getter must not run");
        },
      },
    );
    await expect(catalog.getRecord(hostile as never)).rejects.toMatchObject({
      code: "INVALID_PROJECTION",
    });
    await expect(
      catalog.getRecordLocations(hostile as never),
    ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
  });
});
