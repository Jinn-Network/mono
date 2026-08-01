// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvidenceCatalogReader } from "@jinn-network/evidence-discovery";

import type { CapturePaths } from "./paths.js";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./paths.js";

const SEALED_COUNT_PAGE = 200;

/**
 * The user-visible retention policy. It claims exactly what the sweep does and no more.
 *
 * The local archive is append-only: `LocalEvidenceRuntime` has no eviction member
 * (`packages/evidence/local-runtime/src/types.ts:101-115`) and `EvidenceRepository` exposes no
 * delete, so a sealed record cannot be removed without reaching past a package boundary. What
 * the product owns — and therefore bounds — is the staged feed and the recorder workspace,
 * both of which are duplicates of bytes already sealed in the archive.
 */
export const RETENTION_POLICY_STATEMENT =
  "Session feeds and capture workspaces are duplicates of material already sealed in your " +
  "archive; they are deleted once older than the retention window. Sealed records are never " +
  "deleted — the local archive is append-only — but captures older than the window are " +
  "excluded from retrieval, so old sessions stop resurfacing in your context.";

export interface RetentionWatermark {
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly sweptAt: string;
  /** Carried so the doctor can report a real loss without re-walking the staging tree. */
  readonly droppedUnsealedSessions: number;
  /** Of those, the ones that carried an end record and could therefore have been sealed. */
  readonly droppedRecoverableSessions: number;
}

export interface CaptureRetentionReport {
  readonly cutoff: string;
  readonly sweptSessions: number;
  readonly sweptWorkspaces: number;
  readonly retainedSessions: number;
  readonly recoveredSessions: number;
  readonly droppedUnsealedSessions: number;
  /**
   * Of the dropped feeds, the ones that carried a `session-close` line — they were sealable
   * and recovery simply never reached them. This is the arm that means something is wrong;
   * the remainder were cut short mid-session and could never have been sealed at all.
   */
  readonly droppedRecoverableSessions: number;
  readonly sealedBeforeCutoff: number;
  readonly sealedCountTruncated: boolean;
}

export interface SweepCaptureRetentionInput {
  readonly paths: CapturePaths;
  readonly retentionDays: number;
  readonly now: Date;
  readonly keepSessionIds?: readonly string[];
  readonly catalog?: EvidenceCatalogReader;
  /** Seals a stranded feed. Supplied by the capability; returns false when it cannot. */
  readonly recover?: (sessionId: string) => Promise<boolean>;
  readonly maxRecoveries?: number;
  readonly signal?: AbortSignal;
}

/** Written into a session's staging directory by `sealSession` once the seal succeeds. */
export const SEAL_MARKER_FILENAME = "sealed.json" as const;

interface StagingEntry {
  readonly name: string;
  readonly path: string;
  readonly modifiedMs: number;
  readonly sealed: boolean;
}

async function listStaging(
  root: string,
  keep: ReadonlySet<string>,
  markerAware: boolean,
): Promise<readonly StagingEntry[]> {
  let names: readonly string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const entries: StagingEntry[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    const path = join(root, name);
    let modifiedMs: number;
    try {
      modifiedMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    let sealed = true;
    if (markerAware) {
      sealed = await stat(join(path, SEAL_MARKER_FILENAME)).then(
        () => true,
        () => false,
      );
    }
    entries.push({ name, path, modifiedMs, sealed });
  }
  return entries.sort((left, right) => left.modifiedMs - right.modifiedMs);
}

/**
 * Whether a staged feed carries a `session-close` line.
 *
 * The discriminator between a drop that means something is wrong (the feed was sealable and
 * recovery never reached it) and one that never could have gone any other way (the process
 * was killed mid-session, so there is no honest outcome or end time to record). Only called
 * for feeds about to be deleted, which is rare.
 */
async function hadEndRecord(sessionDir: string): Promise<boolean> {
  try {
    const text = await readFile(join(sessionDir, "feed.ndjson"), "utf8");
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    const last = body.slice(body.lastIndexOf("\n") + 1);
    if (last.length === 0) return false;
    return (JSON.parse(last) as { readonly type?: unknown }).type === "session-close";
  } catch {
    return false;
  }
}

async function countSealedBefore(
  catalog: EvidenceCatalogReader | undefined,
  cutoff: string,
  signal: AbortSignal | undefined,
): Promise<{ count: number; truncated: boolean }> {
  if (catalog === undefined) return { count: 0, truncated: false };
  try {
    const page = await catalog.findExecutions(
      { startedBefore: cutoff, limit: SEALED_COUNT_PAGE },
      signal === undefined ? undefined : { signal },
    );
    return {
      count: page.items.length,
      truncated: page.items.length >= SEALED_COUNT_PAGE,
    };
  } catch {
    // Observability only. A catalog that cannot answer must never fail a capture.
    return { count: 0, truncated: false };
  }
}

export async function sweepCaptureRetention(
  input: SweepCaptureRetentionInput,
): Promise<CaptureRetentionReport> {
  const cutoffMs = input.now.getTime() - input.retentionDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const keep = new Set(input.keepSessionIds ?? []);
  const maxRecoveries = input.maxRecoveries ?? 3;

  const sessionEntries = await listStaging(input.paths.sessionsDirectory, keep, true);
  let sweptSessions = 0;
  let retainedSessions = 0;
  let recoveredSessions = 0;
  let droppedUnsealedSessions = 0;
  let droppedRecoverableSessions = 0;
  let recoveryBudget = input.recover === undefined ? 0 : maxRecoveries;

  for (const entry of sessionEntries) {
    let sealed = entry.sealed;
    // A stranded feed (C7 finding F-C7-7): the adapter could not seal it because the archive
    // was busy, so nothing else owns it. Offer it to the capability before considering it
    // disposable — oldest first, bounded, and never fatal.
    if (!sealed && recoveryBudget > 0 && input.recover !== undefined) {
      recoveryBudget -= 1;
      sealed = await input.recover(entry.name).catch(() => false);
      if (sealed) recoveredSessions += 1;
    }
    if (entry.modifiedMs >= cutoffMs) {
      retainedSessions += 1;
      continue;
    }
    if (!sealed) {
      // Past the window and still unsealed. Dropping is a real loss, so it is counted rather
      // than absorbed into the ordinary duplicate sweep — and split by whether it was ever
      // sealable, because the two cases warrant completely different advice.
      droppedUnsealedSessions += 1;
      if (await hadEndRecord(entry.path)) droppedRecoverableSessions += 1;
    }
    await rm(entry.path, { recursive: true, force: true });
    sweptSessions += 1;
  }

  const workspaceEntries = await listStaging(input.paths.workspacesDirectory, keep, false);
  let sweptWorkspaces = 0;
  for (const entry of workspaceEntries) {
    if (entry.modifiedMs >= cutoffMs) continue;
    await rm(entry.path, { recursive: true, force: true });
    sweptWorkspaces += 1;
  }

  // Sessions the caller asked to keep are excluded from `listStaging`; count the ones that
  // exist so `retainedSessions` describes the whole staging tree.
  for (const name of keep) {
    const present = await stat(join(input.paths.sessionsDirectory, name)).then(
      () => true,
      () => false,
    );
    if (present) retainedSessions += 1;
  }

  const sealed = await countSealedBefore(input.catalog, cutoff, input.signal);

  await ensureOwnerOnlyDirectory(input.paths.captureDirectory);
  const watermark: RetentionWatermark = {
    retentionDays: input.retentionDays,
    cutoff,
    sweptAt: input.now.toISOString(),
    droppedUnsealedSessions,
    droppedRecoverableSessions,
  };
  await writeFile(input.paths.retentionWatermarkPath, `${JSON.stringify(watermark)}\n`, {
    mode: 0o600,
  });
  await ensureOwnerOnlyFile(input.paths.retentionWatermarkPath);

  return {
    cutoff,
    sweptSessions,
    sweptWorkspaces,
    retainedSessions,
    recoveredSessions,
    droppedUnsealedSessions,
    droppedRecoverableSessions,
    sealedBeforeCutoff: sealed.count,
    sealedCountTruncated: sealed.truncated,
  };
}

/** The exclusion boundary C6 reads. `null` means no sweep has run yet. */
export async function readRetentionWatermark(
  paths: CapturePaths,
): Promise<RetentionWatermark | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.retentionWatermarkPath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as RetentionWatermark).cutoff !== "string" ||
      typeof (parsed as RetentionWatermark).sweptAt !== "string" ||
      typeof (parsed as RetentionWatermark).retentionDays !== "number" ||
      typeof (parsed as RetentionWatermark).droppedUnsealedSessions !== "number" ||
      typeof (parsed as RetentionWatermark).droppedRecoverableSessions !== "number"
    ) {
      return null;
    }
    return parsed as RetentionWatermark;
  } catch {
    return null;
  }
}

/**
 * Session staging directories that carry no seal marker — captures nothing else owns.
 * Ordered oldest first, so a bounded recovery pass takes the ones most at risk of eviction.
 *
 * Exported so a caller can find out whether recovery has anything to do *before* taking the
 * archive's exclusive lock. Discovering "nothing to recover" must not cost a lock.
 */
export async function listStrandedSessionIds(
  paths: CapturePaths,
  exclude: readonly string[] = [],
): Promise<readonly string[]> {
  const entries = await listStaging(paths.sessionsDirectory, new Set(exclude), true);
  return entries.filter((entry) => !entry.sealed).map((entry) => entry.name);
}
