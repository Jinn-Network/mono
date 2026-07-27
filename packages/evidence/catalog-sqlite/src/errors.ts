// SPDX-License-Identifier: MIT
import { EvidenceCatalogError } from "@jinn-network/evidence-discovery";

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export function catalogIoError(
  error: unknown,
  message: string,
): EvidenceCatalogError {
  if (error instanceof EvidenceCatalogError) return error;
  const code = nodeErrorCode(error);
  const detail =
    code === undefined ? message : `${message} (${code})`;
  return new EvidenceCatalogError("IO_FAILURE", detail, { cause: error });
}

export function closedCatalogError(): EvidenceCatalogError {
  return new EvidenceCatalogError(
    "IO_FAILURE",
    "The SQLite Evidence Catalog is closed.",
  );
}
