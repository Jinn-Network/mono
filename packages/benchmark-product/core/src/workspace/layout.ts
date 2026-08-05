/**
 * The workspace's on-disk layout (spec §4.5, assumption A4).
 *
 * The drafts / sealed-records / artifacts / journal split is normative; the exact
 * directory and file names below are implementation detail this module owns. Every
 * other module resolves workspace paths through these helpers, never by joining
 * string literals of its own.
 */

import { join } from "node:path";

export const WORKSPACE_METADATA_FILENAME = "workspace.json";
export const DRAFTS_DIRNAME = "drafts";
export const RECORDS_DIRNAME = "records";
export const ARTIFACTS_DIRNAME = "artifacts";
export const JOURNAL_FILENAME = "journal.jsonl";
export const AUTHORITY_FILENAME = "authority.json";

export function workspaceMetadataPath(workspaceDir: string): string {
  return join(workspaceDir, WORKSPACE_METADATA_FILENAME);
}

/** Mutable product documents, plain JSON, freely edited before lock (spec §4.5). */
export function draftsDir(workspaceDir: string): string {
  return join(workspaceDir, DRAFTS_DIRNAME);
}

export function draftPath(workspaceDir: string, draftId: string): string {
  return join(draftsDir(workspaceDir), `${draftId}.json`);
}

/** Sealed records as exact bytes, addressed by digest (spec §4.5). */
export function recordsDir(workspaceDir: string): string {
  return join(workspaceDir, RECORDS_DIRNAME);
}

/** Derived outputs: preview artifacts, results JSON, claim packages, report bundles. */
export function artifactsDir(workspaceDir: string): string {
  return join(workspaceDir, ARTIFACTS_DIRNAME);
}

/** The append-only audit journal (spec §4.4). */
export function journalPath(workspaceDir: string): string {
  return join(workspaceDir, JOURNAL_FILENAME);
}

/** The per-workspace authority policy document (spec §4.2). */
export function authorityPath(workspaceDir: string): string {
  return join(workspaceDir, AUTHORITY_FILENAME);
}
