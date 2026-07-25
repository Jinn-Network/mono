// SPDX-License-Identifier: MIT
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
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
import { openLocalEvidenceRuntime } from "./runtime.js";

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

      const rebuilding = await openLocalEvidenceRuntime({ rootDir: root });
      await vi.waitFor(async () => {
        expect((await rebuilding.getStatus()).state).toBe("rebuilding");
      });
      const generationsDir = join(root, "catalog", "generations");
      await vi.waitFor(async () => {
        const databases = (await readdir(generationsDir))
          .filter((name) => name.endsWith(".sqlite"));
        expect(databases.length).toBeGreaterThanOrEqual(2);
      });
      await chmod(generationsDir, 0o500);
      try {
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
      } finally {
        await chmod(generationsDir, 0o700);
        await rebuilding.close();
      }
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
