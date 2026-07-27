// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExecutionEvidenceProjection,
} from "@jinn-network/evidence-discovery";
import {
  createCatalogContractFixtures,
  describeEvidenceCatalogContract,
} from "@jinn-network/evidence-discovery/testing";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
} from "./index.js";
import type { SqliteEvidenceCatalog } from "./types.js";

const generation = {
  catalogSchemaVersion: "1.0.0",
  projectorVersion: "projector-fixture",
  createdAt: "2026-07-25T00:00:00Z",
} as const;

let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-catalog-reader-"));
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function createCatalog(label: string): Promise<SqliteEvidenceCatalog> {
  return createSqliteEvidenceCatalog({
    databasePath: join(
      temporaryRoot,
      `${label.replaceAll(/[^a-z0-9]+/giu, "-")}-${randomUUID()}.sqlite`,
    ),
    generation,
  });
}

describeEvidenceCatalogContract(async (name) => {
  const catalog = await createCatalog(name);
  return {
    reader: catalog,
    writer: catalog,
    cleanup: () => catalog.close(),
  };
});

describe("SQLite Evidence Catalog Reader", () => {
  const fixtures = createCatalogContractFixtures();

  async function makeAvailable(
    catalog: SqliteEvidenceCatalog,
    projection: ExecutionEvidenceProjection,
    suffix: string,
  ): Promise<void> {
    await catalog.putRecordProjection(projection);
    await catalog.observeRecordLocation(projection.reference, {
      sourceId: `source-${suffix}`,
      announcementId: `available-${suffix}`,
      repositoryId: `repository-${suffix}`,
    });
  }

  test("uses bounded private cursors and rejects hostile or cross-query reuse", async () => {
    const catalog = await createCatalog("cursor");
    await makeAvailable(catalog, fixtures.privateExecution, "a");
    await makeAvailable(catalog, fixtures.publicDerivative, "b");

    const first = await catalog.findExecutions({ limit: 1 });
    expect(first.items).toEqual([fixtures.privateExecution]);
    expect(first.nextCursor).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    );
    expect(decoded).toMatchObject({
      version: 1,
      order: [
        Date.parse(fixtures.privateExecution.startedAt),
        fixtures.privateExecution.reference.digest,
      ],
    });
    expect(typeof decoded.queryHash).toBe("string");

    const second = await catalog.findExecutions({
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toEqual([fixtures.publicDerivative]);
    expect(second.nextCursor).toBeUndefined();

    await expect(
      catalog.findExecutions({
        cursor: first.nextCursor,
        executorId: "urn:changed",
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.findEvaluations({ cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.findExecutions({ cursor: `${first.nextCursor}=`, limit: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.findExecutions(
        Object.defineProperty({}, "limit", {
          enumerable: true,
          get: () => 1,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await catalog.close();
  });

  test("chooses the lexicographically smallest portable representative", async () => {
    const catalog = await createCatalog("portable");
    await catalog.putRecordProjection(fixtures.privateExecution);
    for (const repositoryId of ["remote-z", "remote-a"]) {
      await catalog.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: repositoryId,
          announcementId: `available-${repositoryId}`,
          repositoryId,
          publishedLocation: {
            bindingProfile: "https://example.invalid/oci",
            locator: { repository: "jinn/evidence", digest: "sha256:fixture" },
          },
        },
      );
    }
    expect(
      await catalog.getRecordLocations(fixtures.privateExecution.reference),
    ).toEqual([
      {
        repositoryId: "remote-a",
        publishedLocation: {
          bindingProfile: "https://example.invalid/oci",
          locator: {
            digest: "sha256:fixture",
            repository: "jinn/evidence",
          },
        },
      },
    ]);
    await catalog.close();
  });

  test("keeps a location available while another source still supports it", async () => {
    const catalog = await createCatalog("remaining-support");
    await catalog.putRecordProjection(fixtures.privateExecution);
    for (const sourceId of ["source-a", "source-b"]) {
      await catalog.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId,
          announcementId: `available-${sourceId.at(-1)}`,
          repositoryId: "shared-repository",
        },
      );
    }
    await expect(
      catalog.withdrawRecordLocationObservation({
        sourceId: "source-a",
        announcementId: "wrong-source",
        retractsAnnouncementId: "available-b",
      }),
    ).rejects.toMatchObject({ code: "LOCATION_CONFLICT" });
    await catalog.withdrawRecordLocationObservation({
      sourceId: "source-a",
      announcementId: "withdrawal-a",
      retractsAnnouncementId: "available-a",
    });

    expect(
      await catalog.getRecordLocations(fixtures.privateExecution.reference),
    ).toEqual([{ repositoryId: "shared-repository" }]);
    expect((await catalog.findExecutions({})).items).toEqual([
      fixtures.privateExecution,
    ]);
    await catalog.close();
  });

  test("reports malformed JSON, missing normalized rows, and foreign-key corruption", async () => {
    for (const corruption of ["json", "family", "foreign-key"] as const) {
      const catalog = await createCatalog(`corrupt-${corruption}`);
      await catalog.putRecordProjection(fixtures.privateExecution);
      const databasePath = catalog.databasePath;
      await catalog.close();

      const raw = new Database(databasePath);
      if (corruption === "json") {
        raw.prepare(`
          UPDATE records SET projection_json = '{'
          WHERE family = ? AND digest = ?
        `).run(
          fixtures.privateExecution.family,
          fixtures.privateExecution.reference.digest,
        );
      } else if (corruption === "family") {
        raw.prepare(`
          DELETE FROM execution_records
          WHERE family = ? AND digest = ?
        `).run(
          fixtures.privateExecution.family,
          fixtures.privateExecution.reference.digest,
        );
      } else {
        raw.pragma("foreign_keys = OFF");
        raw.prepare(`
          INSERT INTO entity_keys (family, digest, entity_id)
          VALUES ('execution-evidence', ?, 'orphan')
        `).run(`sha256:${"f".repeat(64)}`);
      }
      raw.close();

      const reopened = await openSqliteEvidenceCatalog({ databasePath });
      if (corruption === "json") {
        await expect(
          reopened.getRecord(fixtures.privateExecution.reference),
        ).rejects.toMatchObject({ code: "IO_FAILURE" });
      } else if (corruption === "family") {
        await expect(
          reopened.findExecutions({ availability: "any" }),
        ).rejects.toMatchObject({ code: "IO_FAILURE" });
      } else {
        await expect(
          reopened.findRecordsForEntity("orphan"),
        ).rejects.toMatchObject({ code: "IO_FAILURE" });
        await expect(reopened.integrityCheck()).resolves.toMatchObject({
          valid: false,
        });
      }
      await reopened.close();
    }
  });

  test("honors abort and closed-handle errors without touching SQLite", async () => {
    const catalog = await createCatalog("lifecycle");
    const controller = new AbortController();
    controller.abort();
    await expect(
      catalog.findExecutions({}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await catalog.close();
    await expect(catalog.findExecutions({})).rejects.toMatchObject({
      code: "IO_FAILURE",
      message: "The SQLite Evidence Catalog is closed.",
    });
  });
});
