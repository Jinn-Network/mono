// SPDX-License-Identifier: Apache-2.0

/**
 * Detects a run whose evidence was IMPORTED from an external harness (`run import`, #2979)
 * rather than driven on a venue, and loads the public `/10` marker that capability
 * `external-import` (issue #3417) seals into the bundle.
 *
 * ## Why both signals are checked
 *
 * `writeExternalRunImport` (`./external-import.ts`) appends the `external-import` journal marker
 * FIRST, before any per-cell entry, precisely so a crash mid-import cannot leave a run that reads
 * as driven. A crash after that append but before the final `writeRunState` therefore leaves the
 * marker present and `externalImportSha256` absent. A detector that consulted only RunState would
 * treat exactly that half-written run as driven. Reading the journal too costs one file read on a
 * path that already reads the whole workspace.
 *
 * ## What the public marker is
 *
 * The workspace-local signals never enter the bundle closure. The capability registers
 * `external-import.json` as a mandatory member: dump digest, declaration digest, source, and one
 * row per sealed Matrix cell. Claim-consistency rebuilds an import-aware disclosure from the
 * declared vector rather than from the Run record (sealed at lock, before import exists).
 */

import {
  buildExternalImportMarker,
  canonicalExternalImportMarkerBytes,
  deriveClaimExternalImport,
  type ClaimExternalImportSection,
  type ExternalImportMarker,
} from "@colophon-claims/check";
import { getSealedBytes } from "../workspace/sealed-store.js";
import {
  ExternalRunImportDeclarationSchema,
  type ExternalRunImportDeclaration,
} from "./external-import.js";
import { readRunJournalEntries } from "./journal.js";
import { readRunState, type RunState } from "./state.js";

/** What the workspace knows about an import, from whichever signal survived. */
export interface ExternalRunImportMarker {
  /** sha256 hex of the sealed `ExternalRunImportDeclaration`, when either signal names it. */
  readonly declarationSha256?: string;
  /** The harness the results came from, when the journal marker survived to name it. */
  readonly harness?: string;
  /** Which durable fact was found — useful in a refusal, and in a test asserting the half-written
   * case is covered. */
  readonly source: "run-state" | "run-journal";
}

/**
 * The durable fact that this run's evidence was imported, or `undefined` for a driven run.
 *
 * `runState` is optional so a caller that already holds it does not re-read it; omitted, it is read
 * here. A missing or unreadable RunState is not evidence of a driven run — the journal is still
 * consulted.
 */
export function externalRunImportMarker(
  workspaceDir: string,
  draftId: string,
  runState?: RunState,
): ExternalRunImportMarker | undefined {
  let state: RunState | undefined = runState;
  if (state === undefined) {
    try {
      state = readRunState(workspaceDir, draftId);
    } catch {
      state = undefined;
    }
  }
  if (state?.externalImportSha256 !== undefined) {
    return { declarationSha256: state.externalImportSha256, source: "run-state" };
  }
  let entries: ReturnType<typeof readRunJournalEntries>;
  try {
    entries = readRunJournalEntries(workspaceDir, draftId);
  } catch {
    // A journal this operation cannot read is a separate refusal every publication path already
    // raises for itself; it is not a licence to treat the run as driven, but neither is it this
    // detector's error to report.
    return undefined;
  }
  for (const entry of entries) {
    if (entry.kind === "external-import") {
      return { declarationSha256: entry.declarationSha256, harness: entry.source.harness, source: "run-journal" };
    }
  }
  return undefined;
}

export function loadSealedImportDeclaration(
  workspaceDir: string,
  declarationSha256: string,
): ExternalRunImportDeclaration {
  const bytes = getSealedBytes(workspaceDir, declarationSha256);
  return ExternalRunImportDeclarationSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

/** The public-bundle marker a `/10` imported run seals: dump identity, declaration digest,
 * source, and one row per slot (cellKey, outcome, optional reason). */
export function publicExternalImportMarker(
  declaration: ExternalRunImportDeclaration,
  declarationSha256: string,
): ExternalImportMarker {
  return buildExternalImportMarker({
    dump: declaration.dump,
    declarationSha256,
    source: declaration.source,
    rows: declaration.rows.map((row) => ({
      cellKey: row.cellKey,
      outcome: row.outcome,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
    })),
  });
}

export interface PublicExternalImportCarriage {
  readonly marker: ExternalImportMarker;
  readonly bytes: Uint8Array;
  readonly claim: ClaimExternalImportSection;
}

/**
 * Loads the sealed declaration and projects the public marker + claim section. `undefined` for a
 * driven run. A half-written import whose journal named the declaration still loads: the
 * declaration is content-addressed and was sealed before the journal marker was appended.
 */
export function loadPublicExternalImport(
  workspaceDir: string,
  draftId: string,
  runState?: RunState,
): PublicExternalImportCarriage | undefined {
  const imported = externalRunImportMarker(workspaceDir, draftId, runState);
  if (imported?.declarationSha256 === undefined) return undefined;
  const declaration = loadSealedImportDeclaration(workspaceDir, imported.declarationSha256);
  const marker = publicExternalImportMarker(declaration, imported.declarationSha256);
  return {
    marker,
    bytes: canonicalExternalImportMarkerBytes(marker),
    claim: deriveClaimExternalImport(marker),
  };
}
