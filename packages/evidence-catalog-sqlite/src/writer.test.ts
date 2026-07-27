// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryEvidenceCatalog,
  type CatalogLocationReceipt,
  type CatalogOperationOptions,
  type CatalogRecordProjection,
  type CatalogWriteReceipt,
  type EvidenceCatalogWriter,
  type EvidenceRecordReference,
  type RecordLocationObservation,
  type RecordLocationWithdrawal,
} from "@jinn-network/evidence-catalog";
import {
  createCatalogContractFixtures,
  describeEvidenceCatalogContract,
} from "@jinn-network/evidence-catalog/testing";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createSqliteEvidenceCatalog } from "./index.js";
import type { SqliteEvidenceCatalog } from "./types.js";

const generation = {
  catalogSchemaVersion: "1.0.0",
  projectorVersion: "projector-fixture",
  createdAt: "2026-07-25T00:00:00Z",
} as const;

let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-catalog-writer-"));
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

class MirroredWriter implements EvidenceCatalogWriter {
  constructor(
    private readonly durable: EvidenceCatalogWriter,
    private readonly mirror: EvidenceCatalogWriter,
  ) {}

  async putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt> {
    const receipt = await this.durable.putRecordProjection(projection, options);
    await this.mirror.putRecordProjection(projection, options);
    return receipt;
  }

  async observeRecordLocation(
    reference: EvidenceRecordReference,
    observation: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    const receipt = await this.durable.observeRecordLocation(
      reference,
      observation,
      options,
    );
    await this.mirror.observeRecordLocation(reference, observation, options);
    return receipt;
  }

  async withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    const receipt =
      await this.durable.withdrawRecordLocationObservation(withdrawal, options);
    await this.mirror.withdrawRecordLocationObservation(withdrawal, options);
    return receipt;
  }
}

describeEvidenceCatalogContract(async (name) => {
  const durable = await createCatalog(name);
  const mirror = new InMemoryEvidenceCatalog();
  return {
    reader: mirror,
    writer: new MirroredWriter(durable, mirror),
    cleanup: () => durable.close(),
  };
});

describe("SQLite Evidence Catalog Writer", () => {
  const fixtures = createCatalogContractFixtures();

  test("rolls back every projection table boundary on injected failure", async () => {
    for (const [table, projection] of [
      ["records", fixtures.privateExecution],
      ["entity_keys", fixtures.privateExecution],
      ["execution_records", fixtures.privateExecution],
      ["evaluation_records", fixtures.evaluation],
      ["verification_records", fixtures.verification],
    ] as const) {
      const catalog = await createCatalog(`rollback-${table}`);
      const raw = new Database(catalog.databasePath);
      raw.exec(`
        CREATE TRIGGER injected_failure
        AFTER INSERT ON ${table}
        BEGIN
          SELECT RAISE(ABORT, 'injected ${table} failure');
        END;
      `);
      raw.close();

      await expect(
        catalog.putRecordProjection(projection),
      ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });

      const inspection = new Database(catalog.databasePath);
      for (const relation of [
        "records",
        "entity_keys",
        "execution_records",
        "execution_results",
        "evaluation_records",
        "evaluation_results",
        "verification_records",
      ]) {
        expect(
          inspection.prepare(`SELECT count(*) FROM ${relation}`).pluck().get(),
          `${table} fault left rows in ${relation}`,
        ).toBe(0);
      }
      inspection.exec("DROP TRIGGER injected_failure");
      inspection.close();
      await catalog.close();
    }
  });

  test("stores a synchronous immutable snapshot of caller-owned data", async () => {
    const catalog = await createCatalog("immutable");
    const projection = structuredClone(fixtures.privateExecution);
    const expected = structuredClone(projection);
    const promise = catalog.putRecordProjection(projection);
    (
      projection.results as {
        entityId: string;
        digest: string;
      }[]
    )[0]!.entityId = "mutated-before-await";
    await expect(promise).resolves.toMatchObject({ status: "created" });
    (
      projection.declaredEntities as { entityId: string; types: string[] }[]
    )[0]!.types.push("Mutated");

    const raw = new Database(catalog.databasePath, { readonly: true });
    const stored = raw
      .prepare("SELECT projection_json FROM records")
      .pluck()
      .get();
    raw.close();
    expect(JSON.parse(String(stored))).toEqual(expected);
    await catalog.close();
  });

  test("isolates cross-source withdrawal and retains independent support", async () => {
    const catalog = await createCatalog("sources");
    await catalog.putRecordProjection(fixtures.privateExecution);
    for (const source of ["source-a", "source-b"]) {
      await catalog.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: source,
          announcementId: `available-${source.at(-1)}`,
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
    await expect(
      catalog.withdrawRecordLocationObservation({
        sourceId: "source-a",
        announcementId: "withdrawal-a",
        retractsAnnouncementId: "available-a",
      }),
    ).resolves.toEqual({ status: "withdrawn" });

    const raw = new Database(catalog.databasePath, { readonly: true });
    expect(
      raw.prepare(`
        SELECT count(*)
        FROM location_observations AS observation
        WHERE observation.family = ?
          AND observation.digest = ?
          AND NOT EXISTS (
            SELECT 1
            FROM location_withdrawals AS withdrawal
            WHERE withdrawal.source_id = observation.source_id
              AND withdrawal.retracts_announcement_id =
                observation.announcement_id
          )
      `).pluck().get(
        fixtures.privateExecution.family,
        fixtures.privateExecution.reference.digest,
      ),
    ).toBe(1);
    raw.close();
    await catalog.close();
  });

  test("rejects a location before its projection and maps hostile projections", async () => {
    const catalog = await createCatalog("invalid");
    await expect(
      catalog.observeRecordLocation(fixtures.privateExecution.reference, {
        sourceId: "source",
        announcementId: "announcement",
        repositoryId: "repository",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    await expect(
      catalog.putRecordProjection({
        ...fixtures.privateExecution,
        byteSize: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    await catalog.close();
  });
});
