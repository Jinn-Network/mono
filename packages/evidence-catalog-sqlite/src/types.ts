// SPDX-License-Identifier: MIT
import type {
  CatalogGeneration,
  CatalogOperationOptions,
  EvidenceCatalogReader,
  EvidenceCatalogWriter,
} from "@jinn-network/evidence-catalog";

export interface SqliteCatalogIntegrityReport {
  readonly valid: boolean;
  readonly messages: readonly string[];
}

export interface SqliteEvidenceCatalog
  extends EvidenceCatalogReader, EvidenceCatalogWriter {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
  integrityCheck(
    options?: CatalogOperationOptions,
  ): Promise<SqliteCatalogIntegrityReport>;
  close(): Promise<void>;
}

export interface CreateSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
}

export interface OpenSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
}
