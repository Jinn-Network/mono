// SPDX-License-Identifier: MIT

import { EvidenceCatalogError } from "./errors.js";
import type {
  CatalogOperationOptions,
  CatalogReferenceSnapshot,
  CatalogSnapshotBoundary,
  EvaluationCatalogQuery,
  EvidenceCatalogReader,
  EvidenceRecordReference,
  ExecutionCatalogQuery,
  VerificationCatalogQuery,
} from "./types.js";

export type CatalogSnapshotRequest =
  | { readonly family: "execution-evidence"; readonly query: Omit<ExecutionCatalogQuery, "cursor" | "limit"> }
  | { readonly family: "result-evaluation"; readonly query: Omit<EvaluationCatalogQuery, "cursor" | "limit"> }
  | { readonly family: "execution-verification"; readonly query: Omit<VerificationCatalogQuery, "cursor" | "limit"> };

/** A reader pinned by its implementation to one source boundary for the view's lifetime. */
export interface EvidenceCatalogSnapshotView {
  readonly reader: EvidenceCatalogReader;
  readonly boundary: CatalogSnapshotBoundary;
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_QUERY", message);
}

function validateBoundary(boundary: CatalogSnapshotBoundary): void {
  if (typeof boundary.sourceCursor !== "string" || boundary.sourceCursor.length === 0) {
    invalid("Snapshot sourceCursor must be non-empty.");
  }
  if (
    typeof boundary.cutoff !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(boundary.cutoff) ||
    !Number.isFinite(Date.parse(boundary.cutoff))
  ) {
    invalid("Snapshot cutoff must be an RFC 3339 timestamp.");
  }
}

function compareReference(left: EvidenceRecordReference, right: EvidenceRecordReference): number {
  const leftKey = `${left.family}\u0000${left.digest}`;
  const rightKey = `${right.family}\u0000${right.digest}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Exhausts a catalog view that the source has already frozen, returning only exact
 * record references. The query is an accelerator; cohort verification must fetch
 * and validate every referenced byte sequence.
 */
export async function enumerateCatalogSnapshot(
  view: EvidenceCatalogSnapshotView,
  request: CatalogSnapshotRequest,
  options?: CatalogOperationOptions,
): Promise<CatalogReferenceSnapshot<CatalogSnapshotRequest["query"]>> {
  validateBoundary(view.boundary);
  const references: EvidenceRecordReference[] = [];
  const seenReferences = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined && seenCursors.has(cursor)) {
      throw new EvidenceCatalogError("IO_FAILURE", "Catalog pagination cursor repeated.");
    }
    if (cursor !== undefined) seenCursors.add(cursor);
    const pagination = { limit: 100, ...(cursor === undefined ? {} : { cursor }) };
    const page = request.family === "execution-evidence"
      ? await view.reader.findExecutions({ ...request.query, ...pagination }, options)
      : request.family === "result-evaluation"
        ? await view.reader.findEvaluations({ ...request.query, ...pagination }, options)
        : await view.reader.findVerifications({ ...request.query, ...pagination }, options);
    for (const item of page.items) {
      const key = `${item.reference.family}\u0000${item.reference.digest}`;
      if (seenReferences.has(key)) {
        throw new EvidenceCatalogError("IO_FAILURE", "Catalog snapshot returned a duplicate record reference.");
      }
      seenReferences.add(key);
      references.push({ ...item.reference });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return {
    family: request.family,
    query: structuredClone(request.query),
    boundary: structuredClone(view.boundary),
    references: references.sort(compareReference),
  };
}
