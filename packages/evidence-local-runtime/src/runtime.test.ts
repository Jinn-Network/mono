// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openFilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-announcement-journal";
import {
  createRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository-fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLocalOperationsStore } from "./operations-store.js";
import {
  openLocalEvidenceRuntime,
  openLocalEvidenceRuntimeForTesting,
} from "./runtime.js";

const protocolFixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(name, protocolFixtureRoot));
}

async function forceProjectorMismatch(root: string): Promise<{
  readonly generationId: string;
}> {
  const pointerPath = join(root, "catalog", "current.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    generationId: string;
    projectorVersion: string;
  };
  await writeFile(pointerPath, `${JSON.stringify({
    ...pointer,
    projectorVersion: "legacy-projector",
  })}\n`, { mode: 0o600 });
  return { generationId: pointer.generationId };
}

function recordMarkerPath(
  root: string,
  reference: EvidenceRecordReference,
): string {
  const digest = reference.digest.slice("sha256:".length);
  return join(
    root,
    "repository",
    "records",
    reference.family,
    "sha256",
    digest.slice(0, 2),
    `${digest.slice(2)}.json`,
  );
}

describe("local evidence runtime", () => {
  it("opens, publishes, indexes a terminal outcome, and restarts identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const initial = await runtime.getStatus();
    expect(initial.state).toBe("ready");
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      new TextEncoder().encode('{"not":"protocol evidence"}'),
    );
    expect(await runtime.awaitIndexed(receipt.reference)).toMatchObject({
      status: "failed",
      reference: receipt.reference,
    });
    await runtime.close();
    expect((await runtime.getStatus()).state).toBe("closed");
    await runtime.close();

    const reopened = await openLocalEvidenceRuntime({ rootDir: root });
    const status = await reopened.getStatus();
    expect(status.sourceId).toBe(initial.sourceId);
    expect(status.repositoryId).toBe(initial.repositoryId);
    await reopened.close();
  });

  it("enforces exclusive roots and closed repository behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-lock-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    await expect(openLocalEvidenceRuntime({ rootDir: root })).rejects.toMatchObject({
      code: "ROOT_IN_USE",
    });
    await runtime.close();
    await expect(runtime.repository.putArtifact(new Uint8Array([1])))
      .rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  it("rejects a corrupt persisted checkpoint before reporting ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-checkpoint-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      await fixture("execution/ro-crate-metadata.json"),
    );
    await expect(runtime.awaitIndexed(receipt.reference))
      .resolves.toMatchObject({ status: "indexed" });
    await runtime.close();

    const database = new Database(
      join(root, "operations", "runtime.sqlite"),
    );
    database.prepare("UPDATE indexer_checkpoints SET cursor = ?")
      .run("not-a-journal-cursor");
    database.close();

    await expect(openLocalEvidenceRuntime({ rootDir: root }))
      .rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
  });

  it.each([
    "DELETE FROM processed_cursors",
    "DELETE FROM indexer_checkpoints",
  ])("rejects torn operational state before reporting ready: %s", async (sql) => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-torn-state-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      await fixture("execution/ro-crate-metadata.json"),
    );
    await expect(runtime.awaitIndexed(receipt.reference))
      .resolves.toMatchObject({ status: "indexed" });
    await runtime.close();

    const database = new Database(
      join(root, "operations", "runtime.sqlite"),
    );
    database.exec(sql);
    database.close();

    await expect(openLocalEvidenceRuntime({ rootDir: root }))
      .rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
  });

  it("rejects active-generation indexing state owned by a foreign source", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-foreign-source-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      await fixture("execution/ro-crate-metadata.json"),
    );
    await expect(runtime.awaitIndexed(receipt.reference))
      .resolves.toMatchObject({ status: "indexed" });
    await runtime.close();

    const database = new Database(
      join(root, "operations", "runtime.sqlite"),
    );
    const foreignSource = "urn:uuid:99999999-9999-4999-8999-999999999999";
    for (const table of [
      "indexer_checkpoints",
      "processed_cursors",
      "indexing_outcomes",
    ]) {
      database.prepare(`UPDATE ${table} SET source_id = ?`).run(foreignSource);
    }
    database.close();

    await expect(openLocalEvidenceRuntime({ rootDir: root }))
      .rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
  });

  it("rebuilds an equivalent disposable Catalog after its active database is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-catalog-rebuild-"));
    roots.push(root);
    const bytes = await fixture("execution/ro-crate-metadata.json");
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      bytes,
    );
    const indexed = await runtime.awaitIndexed(receipt.reference);
    expect(indexed.status).toBe("indexed");
    const projection = await runtime.catalog.getRecord(receipt.reference);
    await runtime.close();

    const pointer = JSON.parse(
      await readFile(join(root, "catalog", "current.json"), "utf8"),
    ) as { databaseFile: string };
    await unlink(join(root, "catalog", "generations", pointer.databaseFile));

    const rebuilt = await openLocalEvidenceRuntime({ rootDir: root });
    expect(Array.from(
      (await rebuilt.repository.getRecord(receipt.reference)) ?? [],
    )).toEqual(Array.from(bytes));
    expect(await rebuilt.catalog.getRecord(receipt.reference))
      .toEqual(projection);
    expect(await rebuilt.awaitIndexed(receipt.reference))
      .toMatchObject({ status: "indexed" });
    await rebuilt.close();
  });

  it("maps post-open private database failures at every status boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-private-error-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const database = new Database(
      join(root, "operations", "runtime.sqlite"),
    );
    database.exec("DROP TABLE indexing_outcomes");
    database.close();

    for (const operation of [
      () => runtime.getStatus(),
      () => runtime.listIndexingFailures(),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "LocalEvidenceRuntimeError",
        code: "RUNTIME_CORRUPT",
        cause: expect.objectContaining({ name: "SqliteError" }),
      });
    }
    await runtime.close().catch(() => undefined);
  });

  it("maps post-open journal corruption as terminal private-state corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-journal-error-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const markerPath = join(root, "announcements", "journal.json");
    const replacementPath = `${markerPath}.replacement`;
    await writeFile(replacementPath, "{}\n");
    await rename(replacementPath, markerPath);

    for (const operation of [() => runtime.sync(), () => runtime.getStatus()]) {
      await expect(operation()).rejects.toMatchObject({
        name: "LocalEvidenceRuntimeError",
        code: "RUNTIME_CORRUPT",
        cause: expect.objectContaining({
          name: "EvidenceAnnouncementJournalError",
          code: "JOURNAL_CORRUPT",
        }),
      });
    }
    await runtime.close().catch(() => undefined);
  });

  it("returns the old reader while a mismatched generation rebuilds and catches concurrent publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-rebuild-"));
    roots.push(root);
    const first = await openLocalEvidenceRuntime({ rootDir: root });
    const execution = await first.repository.putRecord(
      "execution-evidence",
      await fixture("execution/ro-crate-metadata.json"),
    );
    expect((await first.awaitIndexed(execution.reference)).status).toBe("indexed");
    await first.close();

    const old = await forceProjectorMismatch(root);
    const rebuilding = await openLocalEvidenceRuntime({ rootDir: root });
    expect(await rebuilding.getStatus()).toMatchObject({
      state: "rebuilding",
      activeGenerationId: old.generationId,
    });
    expect(await rebuilding.catalog.getRecord(execution.reference)).not.toBeNull();

    const evaluation = await rebuilding.repository.putRecord(
      "result-evaluation",
      await fixture("claims/result-evaluation/result-evaluation.dsse.json"),
    );
    await vi.waitFor(async () => {
      const status = await rebuilding.getStatus();
      expect(status.state).toBe("ready");
      expect(status.activeGenerationId).not.toBe(old.generationId);
    }, { timeout: 10_000 });
    expect(await rebuilding.catalog.getRecord(execution.reference)).not.toBeNull();
    expect(await rebuilding.catalog.getRecord(evaluation.reference)).not.toBeNull();
    const operations = await openLocalOperationsStore(
      join(root, "operations", "runtime.sqlite"),
    );
    expect(await operations.getOutcome(old.generationId, evaluation.reference))
      .toMatchObject({ status: "indexed" });
    await operations.close();
    await rebuilding.close();
  }, 20_000);

  it("returns degraded instead of blocking open on a retryable missing record", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-retry-"));
    roots.push(root);
    const initial = await openLocalEvidenceRuntime({ rootDir: root });
    const status = await initial.getStatus();
    await initial.close();

    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: join(root, "announcements"),
      sourceId: status.sourceId,
    });
    const missingBytes = new TextEncoder().encode(
      '{"temporarily":"absent"}',
    );
    const missing = createRecordReference(
      "execution-evidence",
      missingBytes,
    );
    await journal.appendAvailable({
      announcementId: "urn:jinn:test:missing-record",
      reference: missing,
      repositoryId: status.repositoryId,
    });
    await journal.close();

    const reopened = await openLocalEvidenceRuntime({ rootDir: root });
    await vi.waitFor(async () => {
      expect(await reopened.getStatus()).toMatchObject({
        state: "degraded",
        transientFailure: {
          reference: missing,
          sourceCode: "RECORD_UNAVAILABLE",
        },
      });
    }, { timeout: 5_000 });
    const rawRepository = await createFilesystemEvidenceRepository({
      rootDir: join(root, "repository"),
    });
    await rawRepository.putRecord("execution-evidence", missingBytes);
    await expect(reopened.sync()).resolves.toMatchObject({
      status: "synchronized",
      failed: 1,
    });
    await vi.waitFor(async () => {
      expect((await reopened.getStatus()).state).toBe("ready");
    }, { timeout: 5_000 });
    await Promise.all([reopened.close(), reopened.close()]);
    expect((await reopened.getStatus()).state).toBe("closed");
  }, 10_000);

  it("opens a compatible generation from its checkpoint without replaying repository bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-checkpoint-"));
    roots.push(root);
    const bytes = await fixture("execution/ro-crate-metadata.json");
    const initial = await openLocalEvidenceRuntime({ rootDir: root });
    const receipt = await initial.repository.putRecord(
      "execution-evidence",
      bytes,
    );
    expect((await initial.awaitIndexed(receipt.reference)).status).toBe("indexed");
    const generationId = (await initial.getStatus()).activeGenerationId;
    await initial.close();
    await unlink(recordMarkerPath(root, receipt.reference));

    const reopened = await openLocalEvidenceRuntime({ rootDir: root });
    await vi.waitFor(async () => {
      expect(await reopened.getStatus()).toMatchObject({
        state: "ready",
        activeGenerationId: generationId,
      });
    });
    expect(await reopened.catalog.getRecord(receipt.reference)).not.toBeNull();
    await reopened.close();
  });

  it.runIf(process.platform !== "win32")(
    "keeps the old pointer and reader active when replacement pointer publication fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "jinn-runtime-pointer-fail-"));
      roots.push(root);
      const bytes = await fixture("execution/ro-crate-metadata.json");
      const initial = await openLocalEvidenceRuntime({ rootDir: root });
      const receipt = await initial.repository.putRecord(
        "execution-evidence",
        bytes,
      );
      expect((await initial.awaitIndexed(receipt.reference)).status).toBe("indexed");
      await initial.close();
      const old = await forceProjectorMismatch(root);
      const pointerPath = join(
        root,
        "catalog",
        "current.json",
      );
      const pointerBytes = await readFile(pointerPath);
      await unlink(recordMarkerPath(root, receipt.reference));

      const rebuilding = await openLocalEvidenceRuntimeForTesting(
        { rootDir: root },
        {
          async publishCatalogPointer() {
            throw Object.assign(
              new Error("Injected replacement pointer publication failure."),
              { code: "EACCES" },
            );
          },
        },
      );
      await vi.waitFor(async () => {
        expect((await rebuilding.getStatus()).state).toBe("rebuilding");
      });
      const rawRepository = await createFilesystemEvidenceRepository({
        rootDir: join(root, "repository"),
      });
      await rawRepository.putRecord("execution-evidence", bytes);
      await vi.waitFor(async () => {
        expect(await rebuilding.getStatus()).toMatchObject({
          state: "degraded",
          activeGenerationId: old.generationId,
        });
      }, { timeout: 10_000 });
      expect(await readFile(pointerPath)).toEqual(pointerBytes);
      expect(await rebuilding.catalog.getRecord(receipt.reference))
        .not.toBeNull();
      await rebuilding.close();
    },
    15_000,
  );

  it("drains an in-flight durable publication and makes concurrent closes idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-runtime-close-drain-"));
    roots.push(root);
    const runtime = await openLocalEvidenceRuntime({ rootDir: root });
    const publishing = runtime.repository.putRecord(
      "execution-evidence",
      new TextEncoder().encode('{"drain":"publication"}'),
    );
    await Promise.resolve();
    await Promise.all([publishing, runtime.close(), runtime.close()]);
    expect((await runtime.getStatus()).state).toBe("closed");
  });
});
