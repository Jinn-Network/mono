// SPDX-License-Identifier: MIT

/**
 * The archive's host-directory layout (product design §8.3).
 *
 * ```
 * <archive>/
 *   derived/
 *     projection.json    re-derivable; throwaway; safe to delete at any moment
 *   adoption.json        NOT re-derivable; locally recorded operator decisions
 * ```
 *
 * **The layout is the label.** §8.3 draws exactly one distinction inside the archive — everything
 * is a re-derivable projection except adoption state — and a reader who has only the directory
 * should be able to act on that distinction without having read the design. So the derivable half
 * lives under a directory whose name says it is derived, the non-derivable half sits outside it,
 * and both documents carry the claim as a field (`derived: true` / `nonDerivable: true`) so a
 * consumer holding one file and not the tree still knows which it has.
 *
 * The adoption log is rewritten whole rather than appended line-by-line, unlike the campaign
 * journal. It is small, it is read in full on every use, and the atomic-rename write is what makes
 * a crash mid-write leave the previous log intact instead of a half-line. The append-only property
 * is in the API (`appendAdoptionRecord` only ever grows `records`), not in the file format.
 */

import { join } from "node:path";
import { atomicWriteFileSync, readTextIfExistsSync } from "../fs-atomic.js";
import { refuse } from "../errors.js";
import {
  ADOPTION_LOG_FILENAME,
  ARCHIVE_DERIVED_DIRNAME,
  ARCHIVE_DIRNAME,
  ARCHIVE_PROJECTION_FILENAME,
  ARCHIVE_PROJECTION_FORMAT_TOKEN,
  ADOPTION_RECORD_FORMAT_TOKEN,
} from "./tokens.js";
import { emptyAdoptionLog } from "./adoption.js";
import { evaluatedHistory } from "./history.js";
import { frontier, frontierMembers } from "./frontier.js";
import { lineageGraph } from "./lineage.js";
import type { OutcomesProjectionRow, WaveReportRow } from "../wave-types.js";
import type {
  AdoptionLog,
  AdoptionRecord,
  ArchiveProjection,
  FrontierDimension,
  FrontierEntry,
} from "./types.js";

export interface ArchiveLayout {
  readonly root: string;
  readonly derivedDir: string;
  readonly projectionPath: string;
  readonly adoptionPath: string;
}

/** The layout, from an archive root. `defaultArchiveRoot` puts it beside a campaign's journal. */
export function archiveLayout(root: string): ArchiveLayout {
  const derivedDir = join(root, ARCHIVE_DERIVED_DIRNAME);
  return {
    root,
    derivedDir,
    projectionPath: join(derivedDir, ARCHIVE_PROJECTION_FILENAME),
    adoptionPath: join(root, ADOPTION_LOG_FILENAME),
  };
}

/** `<campaignDir>/archive` — the archive of one campaign's population. */
export function defaultArchiveRoot(campaignDirectory: string): string {
  return join(campaignDirectory, ARCHIVE_DIRNAME);
}

export interface DeriveArchiveInput {
  /** Sealed candidate-manifest bytes, in any order. */
  readonly manifests: readonly Uint8Array[];
  readonly reports?: readonly WaveReportRow[];
  readonly outcomes?: readonly OutcomesProjectionRow[];
  /** Frontier positions, supplied by whoever holds the measurements. Absent → an empty frontier. */
  readonly frontierEntries?: readonly FrontierEntry[];
  readonly dimensions: readonly FrontierDimension[];
}

/**
 * The whole re-derivable half, in one pass.
 *
 * A history is produced for every tuple the lineage carries, including tuples with no Reports at
 * all: an admitted candidate nobody has measured yet is a real state of the archive, and omitting
 * it would make "no evidence" indistinguishable from "not in the population".
 */
export function deriveArchive(input: DeriveArchiveInput): ArchiveProjection {
  const lineage = lineageGraph(input.manifests);
  const tupleDigests = [...new Set(lineage.nodes.map((node) => node.tupleDigest))].sort();
  const entries = input.frontierEntries ?? [];
  return {
    formatToken: ARCHIVE_PROJECTION_FORMAT_TOKEN,
    derived: true,
    note:
      "A derived projection over candidate manifests, Reports, and projection rows (product design "
      + "§8.3). Re-derivable, never authoritative, never a ranking. Safe to delete.",
    lineage,
    histories: tupleDigests.map((digest) =>
      evaluatedHistory(input.reports ?? [], input.outcomes ?? [], digest)),
    frontier: entries.length === 0 ? [] : frontierMembers(frontier(entries, input.dimensions)),
    dimensions: input.dimensions,
  };
}

function readJsonIfExists(path: string): unknown {
  const text = readTextIfExistsSync(path);
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    refuse("invalid-document", path, "the file is not JSON");
  }
}

export function writeArchiveProjection(layout: ArchiveLayout, projection: ArchiveProjection): void {
  atomicWriteFileSync(layout.projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
}

/** Reads the derived projection, or `undefined` when it has not been written (or was deleted). */
export function readArchiveProjection(layout: ArchiveLayout): ArchiveProjection | undefined {
  const value = readJsonIfExists(layout.projectionPath);
  if (value === undefined) return undefined;
  const projection = value as ArchiveProjection;
  if (projection.formatToken !== ARCHIVE_PROJECTION_FORMAT_TOKEN) {
    refuse("invalid-document", layout.projectionPath,
      `formatToken must be ${ARCHIVE_PROJECTION_FORMAT_TOKEN}`);
  }
  return projection;
}

/**
 * Reads the adoption log, or an empty one when the file does not exist.
 *
 * An absent log means "no adoption decisions yet", which is a legal state and the state every
 * archive starts in. A *malformed* one refuses: this is the file no re-derivation can rebuild, so
 * reading past a corrupt one would silently discard the only copy of a decision.
 */
export function readAdoptionLog(layout: ArchiveLayout): AdoptionLog {
  const value = readJsonIfExists(layout.adoptionPath);
  if (value === undefined) return emptyAdoptionLog();
  const log = value as AdoptionLog;
  if (log.formatToken !== ADOPTION_RECORD_FORMAT_TOKEN) {
    refuse("invalid-document", layout.adoptionPath,
      `formatToken must be ${ADOPTION_RECORD_FORMAT_TOKEN}`);
  }
  if (!Array.isArray(log.records)) {
    refuse("invalid-document", layout.adoptionPath, "records must be an array");
  }
  return { ...log, nonDerivable: true, records: [...log.records] };
}

/** Appends one record and writes the log. Never rewrites or removes an existing record. */
export function appendAdoptionRecord(layout: ArchiveLayout, record: AdoptionRecord): AdoptionLog {
  const log = readAdoptionLog(layout);
  const next: AdoptionLog = { ...log, records: [...log.records, record] };
  atomicWriteFileSync(layout.adoptionPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
