// SPDX-License-Identifier: Apache-2.0

/**
 * The publication gate for a run whose evidence was IMPORTED from an external harness
 * (`run import`, #2979) rather than driven on a venue.
 *
 * ## Why publication is refused rather than adjusted
 *
 * Every Report this product seals carries the local-venue disclosure verbatim
 * (`../operations/run-results.ts`, `LOCAL_VENUE_LIMITS`), and its third line reads:
 *
 * > Run pinning on the harness, model, and loadout axes is enforced by an admission gate at
 * > dispatch time.
 *
 * For an imported run that sentence is false. No venue dispatched these cells, no admission gate
 * ever ran, and the same bundle's own cells report every pinning axis as `unverifiable`. Publishing
 * it would put a self-contradicting claim inside a signed disclosure — the one artifact whose whole
 * purpose is to state honestly what the run does and does not prove.
 *
 * It cannot be corrected inside the import feature. Both the workspace verifier
 * (`../verification/claim-consistency.ts`) and the shipped reader
 * (`@colophon-claims/verify`, `profile/claim-consistency.ts`) derive the EXPECTED disclosure from
 * `localVenueLimitsForRun(runRecord)` — a pure function of the Run record, which is sealed at
 * `lock`, before import exists. The two facts that DO record the import — `RunState`'s
 * `externalImportSha256` and the `external-import` run-journal entry — are workspace-local: neither
 * enters the bundle closure, and the reader rejects bundle members it does not expect. So a
 * truthful disclosure needs a bundle-VISIBLE import marker, which is a format change.
 *
 * That marker is issue **#3417** — registering `external-import` as a capability under the ratified
 * `/8` capability vector. Until it lands, publication of an imported run is refused. The refusal is
 * the honest position: the import path itself (readers, slate validation, sealed-record synthesis,
 * matrix re-derivation) is intact and exercised end to end, and only the act that would hand a
 * reader a contradictory signed disclosure is closed.
 *
 * ## Why BOTH signals are checked
 *
 * `writeExternalRunImport` (`./external-import.ts`) appends the `external-import` journal marker
 * FIRST, before any per-cell entry, precisely so a crash mid-import cannot leave a run that reads
 * as driven. A crash after that append but before the final `writeRunState` therefore leaves the
 * marker present and `externalImportSha256` absent. A gate that consulted only RunState would let
 * exactly that half-written run through. Reading the journal too costs one file read on a path that
 * already reads the whole workspace.
 */

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
    // gate's error to report.
    return undefined;
  }
  for (const entry of entries) {
    if (entry.kind === "external-import") {
      return { declarationSha256: entry.declarationSha256, harness: entry.source.harness, source: "run-journal" };
    }
  }
  return undefined;
}

/** The exact refusal detail, so the CLI, the GUI, and every test read one sentence, not five. */
export function importedRunPublicationRefusal(draftId: string, marker: ExternalRunImportMarker): string {
  const harness = marker.harness === undefined ? "an external harness" : `the external harness "${marker.harness}"`;
  return `draft ${draftId} imported its results from ${harness} (\`run import\`), so publication is `
    + "refused. Every Report this product seals states that \"Run pinning on the harness, model, and "
    + "loadout axes is enforced by an admission gate at dispatch time\" — for an imported run no "
    + "venue dispatched anything and no admission gate ran, while the same bundle reports every "
    + "pinning axis as unverifiable, so publishing it would seal a disclosure that contradicts "
    + "itself. The import is recorded only in this workspace (RunState and the run journal); it "
    + "never enters the bundle closure, and the shipped reader rejects members it does not expect, "
    + "so an honest bundle needs a reader-visible import marker first. That marker is issue #3417 "
    + "(registering `external-import` as a capability under the ratified `/8` capability vector). "
    + "Until it lands there is no supported way to publish this run: the imported records, the "
    + "sealed Matrix, and the signed Report remain readable in the workspace.";
}
