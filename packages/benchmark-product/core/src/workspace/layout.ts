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
export const RUNS_DIRNAME = "runs";
export const PREVIEWS_DIRNAME = "previews";
export const RUNTIME_HOSTS_DIRNAME = "runtime-hosts";

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

/** Official-run state and per-run journals (BP-12: run wiring, spec §4.1 locked→…→closed). */
export function runsDir(workspaceDir: string): string {
  return join(workspaceDir, RUNS_DIRNAME);
}

/** `<ws>/runs/<draftId>.json` — the RunState document for a draft's official run. */
export function runStatePath(workspaceDir: string, draftId: string): string {
  return join(runsDir(workspaceDir), `${draftId}.json`);
}

/** `<ws>/runs/<draftId>.journal.jsonl` — the append-only per-run cell-status journal. */
export function runJournalPath(workspaceDir: string, draftId: string): string {
  return join(runsDir(workspaceDir), `${draftId}.journal.jsonl`);
}

/**
 * `<ws>/runs/<draftId>.cancel-requested.json` — the durable cancel-requested marker (BP-22,
 * plan decision 1). Written once, atomically, by the gated `run.cancel` operation BEFORE any
 * other effect, and never removed: its validated presence is the fact `run.collect`/`run.resume`'s
 * guards and the shared assembly-ports construction (`../run/assembly-ports.ts`) key off, so it
 * must outlive the run it describes. `../run/cancel-marker.ts` owns reading and writing it.
 */
export function runCancelMarkerPath(workspaceDir: string, draftId: string): string {
  return join(runsDir(workspaceDir), `${draftId}.cancel-requested.json`);
}

/** `<ws>/runs/<draftId>.finalization.lock` — short-lived cross-process single-writer boundary
 * shared by natural collect and cancellation finalization (BP-22 review correction). */
export function runFinalizationLockPath(workspaceDir: string, draftId: string): string {
  return join(runsDir(workspaceDir), `${draftId}.finalization.lock`);
}

/** Short-lived cross-process single-writer boundary for the RunState/draft publication pair. */
export function runPublicationLockPath(workspaceDir: string, draftId: string): string {
  return join(runsDir(workspaceDir), `${draftId}.publication.lock`);
}

/** `<ws>/artifacts/<draftId>/results.json` — the derived results artifact (spec §4.5). */
export function resultsArtifactPath(workspaceDir: string, draftId: string): string {
  return join(artifactsDir(workspaceDir), draftId, "results.json");
}

/** `<ws>/artifacts/<draftId>/claim-package.json` — the derived claim package artifact (BP-13,
 * spec §8.2). */
export function claimPackageArtifactPath(workspaceDir: string, draftId: string): string {
  return join(artifactsDir(workspaceDir), draftId, "claim-package.json");
}

/** Parent for immutable digest-addressed public bundles. */
export function publicBundlesDir(workspaceDir: string, draftId: string): string {
  return join(artifactsDir(workspaceDir), draftId, "public-bundles");
}

/** `<ws>/artifacts/<draftId>/public-bundles/<manifest-sha256>`. */
export function publicBundlePath(workspaceDir: string, draftId: string, identity: string): string {
  return join(publicBundlesDir(workspaceDir, draftId), identity);
}

/**
 * `previews/` (BP-20, spec §7.2: preview = disclosed rehearsal) — the disposable-rehearsal area.
 * Everything under it is a derived, disposable artifact of an unregistered local run, never an
 * official record: a preview is disclosed everywhere it appears and never enters official results.
 * Created lazily, the same precedent `runsDir` above already sets for the official run's own
 * on-disk area.
 */
export function previewsDir(workspaceDir: string): string {
  return join(workspaceDir, PREVIEWS_DIRNAME);
}

/** `<ws>/previews/<draftId>` — one draft's previews. */
export function draftPreviewsDir(workspaceDir: string, draftId: string): string {
  return join(previewsDir(workspaceDir), draftId);
}

/** `<ws>/previews/<draftId>/log.json` — the draft's append-only preview log (BP-20). */
export function previewLogPath(workspaceDir: string, draftId: string): string {
  return join(draftPreviewsDir(workspaceDir, draftId), "log.json");
}

/** `<ws>/previews/<draftId>/<previewId>` — one preview's own directory. */
export function previewDir(workspaceDir: string, draftId: string, previewId: string): string {
  return join(draftPreviewsDir(workspaceDir, draftId), previewId);
}

/** `<ws>/previews/<draftId>/<previewId>/preview.json` — the preview's disclosed artifact. */
export function previewArtifactPath(workspaceDir: string, draftId: string, previewId: string): string {
  return join(previewDir(workspaceDir, draftId, previewId), "preview.json");
}

/** `<ws>/previews/<draftId>/<previewId>/journal.jsonl` — the preview's raw cell-event journal. */
export function previewJournalPath(workspaceDir: string, draftId: string, previewId: string): string {
  return join(previewDir(workspaceDir, draftId, previewId), "journal.jsonl");
}

/** `<ws>/previews/<draftId>/<previewId>/scratch` — the disposable scratch venue root a preview
 * rehearses against; never the official venue root under the workspace directly. */
export function previewScratchDir(workspaceDir: string, draftId: string, previewId: string): string {
  return join(previewDir(workspaceDir, draftId, previewId), "scratch");
}

/** Private connection state for optional runtime workers. Never part of sealed records/bundles. */
export function runtimeHostsDir(workspaceDir: string): string {
  return join(workspaceDir, RUNTIME_HOSTS_DIRNAME);
}

export function runtimeHostPath(workspaceDir: string, selectionManifestSha256: string): string {
  return join(runtimeHostsDir(workspaceDir), `${selectionManifestSha256}.json`);
}
