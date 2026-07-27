// SPDX-License-Identifier: MIT
import type { CatalogOperationOptions } from "./types.js";

export const EVIDENCE_CATALOG_ERROR_CODES = [
  "INVALID_QUERY",
  "INVALID_PROJECTION",
  "PROJECTION_CONFLICT",
  "LOCATION_CONFLICT",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;

export type EvidenceCatalogErrorCode =
  (typeof EVIDENCE_CATALOG_ERROR_CODES)[number];

export class EvidenceCatalogError extends Error {
  override readonly name = "EvidenceCatalogError";

  constructor(
    readonly code: EvidenceCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertCatalogOperationActive(
  options?: CatalogOperationOptions,
): void {
  if (options?.signal?.aborted) {
    throw new EvidenceCatalogError(
      "OPERATION_ABORTED",
      "The Catalog operation was aborted.",
    );
  }
}
