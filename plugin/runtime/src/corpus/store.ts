// SPDX-License-Identifier: Apache-2.0

import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
  type SqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";
import { CATALOG_SCHEMA_VERSION } from "@jinn-network/evidence-discovery";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";

import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";

export const CORPUS_PROJECTOR_VERSION = "jinn-plugin-corpus-mirror/1.0.0" as const;

export interface CorpusMirrorStore {
  readonly catalog: SqliteEvidenceCatalog;
  readonly repository: EvidenceRepository;
  close(): Promise<void>;
}

export interface OpenCorpusMirrorStoreOptions {
  readonly catalogPath: string;
  readonly objectsDirectory: string;
  readonly fs: CorpusFilesystem;
  readonly now?: () => Date;
}

async function exists(fs: CorpusFilesystem, path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Opens the public-corpus mirror's own catalog and object store.
 *
 * Deliberately NOT `openLocalEvidenceRuntime`: that takes an exclusive-or-fail
 * root lock (`packages/evidence/local-runtime/src/lock.ts:37,46,80`), which
 * would let a mid-write sync starve a concurrent pickup. The SQLite catalog
 * opened directly runs in WAL with `busy_timeout = 5000`
 * (`packages/evidence/catalog-sqlite/src/database.ts:187-196`), so one writer
 * and many readers coexist — which is exactly what "sync never blocks pickup"
 * requires at the storage layer.
 *
 * Per C3's capability rule, this is opened PER OPERATION and closed after;
 * prefer `withCorpusMirrorStore`.
 */
export async function openCorpusMirrorStore(
  options: OpenCorpusMirrorStoreOptions,
): Promise<CorpusMirrorStore> {
  const now = options.now ?? (() => new Date());
  const repository = await createFilesystemEvidenceRepository({
    rootDir: options.objectsDirectory,
  });

  let catalog: SqliteEvidenceCatalog;
  if (await exists(options.fs, options.catalogPath)) {
    catalog = await openSqliteEvidenceCatalog({ databasePath: options.catalogPath });
  } else {
    try {
      catalog = await createSqliteEvidenceCatalog({
        databasePath: options.catalogPath,
        generation: {
          catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
          projectorVersion: CORPUS_PROJECTOR_VERSION,
          createdAt: now().toISOString(),
        },
      });
    } catch (error) {
      // `createSqliteEvidenceCatalog` reserves the file with O_CREAT|O_EXCL,
      // so a concurrent instance can win this race. Re-open rather than fail.
      if (await exists(options.fs, options.catalogPath)) {
        catalog = await openSqliteEvidenceCatalog({ databasePath: options.catalogPath });
      } else {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.mirrorStoreIo,
          `Unable to create the corpus mirror catalog at ${options.catalogPath}.`,
          { cause: error },
        );
      }
    }
  }

  let closed = false;
  return {
    catalog,
    repository,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await catalog.close();
    },
  };
}

/** Opens the store, runs `use`, and closes the store on every path. */
export async function withCorpusMirrorStore<T>(
  options: OpenCorpusMirrorStoreOptions,
  use: (store: CorpusMirrorStore) => Promise<T>,
): Promise<T> {
  const store = await openCorpusMirrorStore(options);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}
