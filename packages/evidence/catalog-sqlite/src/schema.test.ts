// SPDX-License-Identifier: MIT
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import {
  SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION,
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
} from "./index.js";

const generation = {
  catalogSchemaVersion: "1.0.0",
  projectorVersion: "projector-fixture",
  createdAt: "2026-07-25T00:00:00Z",
} as const;

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jinn-catalog-sqlite-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SQLite Evidence Catalog schema", () => {
  test("creates metadata, applies schema version one, and reopens the generation", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "private", "catalog.sqlite");
    const catalog = await createSqliteEvidenceCatalog({
      databasePath,
      generation,
    });

    expect(SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION).toBe(1);
    expect(catalog.generation).toEqual(generation);
    expect(catalog.databasePath).toBe(databasePath);
    expect(await catalog.integrityCheck()).toEqual({ valid: true, messages: [] });
    await catalog.close();

    const reopened = await openSqliteEvidenceCatalog({ databasePath });
    expect(reopened.generation).toEqual(generation);
    expect(await reopened.integrityCheck()).toEqual({
      valid: true,
      messages: [],
    });
    await reopened.close();

    const raw = new Database(databasePath, { readonly: true });
    expect(
      raw.prepare(
        "SELECT sqlite_schema_version FROM catalog_metadata WHERE singleton = 1",
      ).pluck().get(),
    ).toBe(1);
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
    raw.close();

    if (process.platform !== "win32") {
      expect((await lstat(dirname(databasePath))).mode & 0o777).toBe(0o700);
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects an existing target and non-database content", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "catalog.sqlite");
    await writeFile(databasePath, "not sqlite");

    await expect(
      createSqliteEvidenceCatalog({ databasePath, generation }),
    ).rejects.toMatchObject({ code: "IO_FAILURE" });
    await expect(
      openSqliteEvidenceCatalog({ databasePath }),
    ).rejects.toMatchObject({ code: "IO_FAILURE" });
    expect(await readFile(databasePath, "utf8")).toBe("not sqlite");
  });

  test("rejects manually changed schema versions", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "catalog.sqlite");
    const catalog = await createSqliteEvidenceCatalog({
      databasePath,
      generation,
    });
    await catalog.close();

    const raw = new Database(databasePath);
    raw.prepare(
      "UPDATE catalog_metadata SET sqlite_schema_version = 999 WHERE singleton = 1",
    ).run();
    raw.close();

    await expect(
      openSqliteEvidenceCatalog({ databasePath }),
    ).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test.runIf(process.platform !== "win32")(
    "rejects symlink database paths and symlink parent directories",
    async () => {
      const root = await temporaryRoot();
      const real = join(root, "real");
      const realDatabase = join(real, "catalog.sqlite");
      const catalog = await createSqliteEvidenceCatalog({
        databasePath: realDatabase,
        generation,
      });
      await catalog.close();

      const databaseLink = join(root, "database-link.sqlite");
      await symlink(realDatabase, databaseLink);
      await expect(
        openSqliteEvidenceCatalog({ databasePath: databaseLink }),
      ).rejects.toMatchObject({ code: "IO_FAILURE" });

      const parentLink = join(root, "parent-link");
      await symlink(real, parentLink);
      await expect(
        openSqliteEvidenceCatalog({
          databasePath: join(parentLink, "catalog.sqlite"),
        }),
      ).rejects.toMatchObject({ code: "IO_FAILURE" });
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects hardlinked databases and symlinked SQLite sidecars before opening",
    async () => {
      const root = await temporaryRoot();
      const databasePath = join(root, "catalog.sqlite");
      const catalog = await createSqliteEvidenceCatalog({
        databasePath,
        generation,
      });
      await catalog.close();

      const hardlinkPath = join(root, "hardlink.sqlite");
      await link(databasePath, hardlinkPath);
      await expect(
        openSqliteEvidenceCatalog({ databasePath }),
      ).rejects.toMatchObject({ code: "IO_FAILURE" });
      await rm(hardlinkPath);

      const sidecarTarget = join(root, "sidecar-target");
      await writeFile(sidecarTarget, "untouched");
      await symlink(sidecarTarget, `${databasePath}-wal`);
      await expect(
        openSqliteEvidenceCatalog({ databasePath }),
      ).rejects.toMatchObject({ code: "IO_FAILURE" });
      expect(await readFile(sidecarTarget, "utf8")).toBe("untouched");
    },
  );

  test("close is idempotent and later operations fail with the closed error", async () => {
    const root = await temporaryRoot();
    const catalog = await createSqliteEvidenceCatalog({
      databasePath: join(root, "catalog.sqlite"),
      generation,
    });
    await catalog.close();
    await catalog.close();

    await expect(catalog.integrityCheck()).rejects.toMatchObject({
      code: "IO_FAILURE",
      message: "The SQLite Evidence Catalog is closed.",
    });
  });

  test.runIf(process.platform !== "win32")(
    "maps denied parent access to Catalog I/O failure",
    async () => {
      if (process.getuid?.() === 0) return;
      const root = await temporaryRoot();
      const denied = join(root, "denied");
      await writeFile(denied, "not a directory");
      await chmod(denied, 0o000);
      try {
        await expect(
          createSqliteEvidenceCatalog({
            databasePath: join(denied, "catalog.sqlite"),
            generation,
          }),
        ).rejects.toMatchObject({ code: "IO_FAILURE" });
      } finally {
        await chmod(denied, 0o600);
      }
    },
  );
});
