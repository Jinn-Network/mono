// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { constants, lstat, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  CATALOG_SCHEMA_VERSION,
} from "@jinn-network/evidence-discovery";
import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
  type SqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";
import { EVIDENCE_PROJECTOR_VERSION } from "@jinn-network/evidence-discovery/indexer";

import {
  LocalEvidenceRuntimeError,
  localRuntimeIoError,
} from "./errors.js";
import { enforcePrivateFile, type LocalRuntimePaths } from "./paths.js";

export interface LocalCatalogPointerV1 {
  readonly format: "jinn-local-catalog-pointer";
  readonly version: 1;
  readonly generationId: `urn:uuid:${string}`;
  readonly databaseFile: string;
  readonly catalogSchemaVersion: string;
  readonly projectorVersion: string;
  readonly createdAt: string;
}

export interface LocalCatalogGeneration {
  readonly pointer: LocalCatalogPointerV1;
  readonly catalog: SqliteEvidenceCatalog;
  readonly compatible: boolean;
}

function validatePointer(value: unknown): LocalCatalogPointerV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The Catalog generation pointer must be an object.",
    );
  }
  const pointer = value as Partial<LocalCatalogPointerV1>;
  const exact = {
    format: pointer.format,
    version: pointer.version,
    generationId: pointer.generationId,
    databaseFile: pointer.databaseFile,
    catalogSchemaVersion: pointer.catalogSchemaVersion,
    projectorVersion: pointer.projectorVersion,
    createdAt: pointer.createdAt,
  };
  if (
    pointer.format !== "jinn-local-catalog-pointer" ||
    pointer.version !== 1 ||
    typeof pointer.generationId !== "string" ||
    !/^urn:uuid:[0-9a-f-]{36}$/iu.test(pointer.generationId) ||
    typeof pointer.databaseFile !== "string" ||
    pointer.databaseFile !== basename(pointer.databaseFile) ||
    !/^catalog-[0-9a-f-]{36}\.sqlite$/iu.test(pointer.databaseFile) ||
    typeof pointer.catalogSchemaVersion !== "string" ||
    typeof pointer.projectorVersion !== "string" ||
    typeof pointer.createdAt !== "string" ||
    !Number.isFinite(Date.parse(pointer.createdAt)) ||
    JSON.stringify(value) !== JSON.stringify(exact)
  ) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The Catalog generation pointer is invalid.",
    );
  }
  return pointer as LocalCatalogPointerV1;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function publishCatalogPointer(
  paths: LocalRuntimePaths,
  pointer: LocalCatalogPointerV1,
): Promise<void> {
  validatePointer(pointer);
  const temporary = join(
    dirname(paths.catalogPointerPath),
    `.current.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(pointer)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.catalogPointerPath);
    await enforcePrivateFile(paths.catalogPointerPath);
    await syncDirectory(dirname(paths.catalogPointerPath));
  } catch (error) {
    throw localRuntimeIoError(error, "Unable to publish the Catalog generation pointer.");
  } finally {
    await handle?.close();
  }
}

export async function createCatalogGeneration(
  paths: LocalRuntimePaths,
): Promise<LocalCatalogGeneration> {
  const uuid = randomUUID();
  const pointer: LocalCatalogPointerV1 = {
    format: "jinn-local-catalog-pointer",
    version: 1,
    generationId: `urn:uuid:${uuid}`,
    databaseFile: `catalog-${uuid}.sqlite`,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    projectorVersion: EVIDENCE_PROJECTOR_VERSION,
    createdAt: new Date().toISOString(),
  };
  try {
    const catalog = await createSqliteEvidenceCatalog({
      databasePath: join(paths.generationsDir, pointer.databaseFile),
      generation: {
        catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
        projectorVersion: EVIDENCE_PROJECTOR_VERSION,
        createdAt: pointer.createdAt,
      },
    });
    await enforcePrivateFile(catalog.databasePath);
    return { pointer, catalog, compatible: true };
  } catch (error) {
    throw localRuntimeIoError(error, "Unable to create a Catalog generation.");
  }
}

export async function openCurrentCatalogGeneration(
  paths: LocalRuntimePaths,
): Promise<LocalCatalogGeneration | null> {
  try {
    let stat;
    try {
      stat = await lstat(paths.catalogPointerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new LocalEvidenceRuntimeError(
        "UNSAFE_PATH",
        "The Catalog generation pointer must be a regular file.",
      );
    }
    await enforcePrivateFile(paths.catalogPointerPath);
    const pointerHandle = await open(
      paths.catalogPointerPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let pointer: LocalCatalogPointerV1;
    try {
      pointer = validatePointer(JSON.parse(await pointerHandle.readFile("utf8")));
    } finally {
      await pointerHandle.close();
    }
    const databasePath = join(paths.generationsDir, pointer.databaseFile);
    try {
      await lstat(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const catalog = await openSqliteEvidenceCatalog({ databasePath });
    await enforcePrivateFile(databasePath);
    const integrity = await catalog.integrityCheck();
    if (!integrity.valid) {
      await catalog.close();
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        `The active Catalog generation is corrupt: ${integrity.messages.join("; ")}`,
      );
    }
    const compatible =
      pointer.catalogSchemaVersion === CATALOG_SCHEMA_VERSION &&
      pointer.projectorVersion === EVIDENCE_PROJECTOR_VERSION &&
      catalog.generation.catalogSchemaVersion === CATALOG_SCHEMA_VERSION &&
      catalog.generation.projectorVersion === EVIDENCE_PROJECTOR_VERSION;
    return { pointer, catalog, compatible };
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    if (error instanceof SyntaxError) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "The Catalog generation pointer is not valid JSON.",
        { cause: error },
      );
    }
    throw localRuntimeIoError(error, "Unable to open the active Catalog generation.");
  }
}
