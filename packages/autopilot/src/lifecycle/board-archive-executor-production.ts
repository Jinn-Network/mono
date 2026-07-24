import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { PROJECT_ID } from '../dispatcher/field-cache.js';
import {
  planBoardArchive,
  type BoardArchiveProjectSnapshot,
} from './board-archive.js';
import type { SelectedCredential } from './credentials.js';
import { withSelectedCredential } from './production-auth.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { isoTimestamp } from './types.js';

/**
 * Board-archive sweep production wiring (jinn-mono#1883). Same state
 * directory family the capability attestation and session logs use
 * (`~/.jinn-client/autopilot/`, see `capability-attestation.ts` /
 * `dispatcher/session-log.ts`).
 */
export const BOARD_ARCHIVE_STATE_DIR = join(homedir(), '.jinn-client', 'autopilot');
export const BOARD_ARCHIVE_MARKER_FILE = 'board-archive-sweep.json';

/** At most once per host per 24h — see `runBoardArchiveSweep`. */
export const BOARD_ARCHIVE_COOLDOWN_MS = 24 * 60 * 60_000;

/** GitHub's aliased-mutation shape bills roughly per aliased field; batching
 *  keeps each `gh api graphql` call to a bounded request size. Matches the
 *  batch size already used successfully for the manual one-off archive. */
export const BOARD_ARCHIVE_BATCH_SIZE = 20;

/** Defensive per-sweep ceiling — leftover candidates are picked up by the
 *  next (throttled) sweep rather than archiving an unbounded batch in one
 *  cycle. */
export const BOARD_ARCHIVE_MAX_PER_SWEEP = 50;

export function boardArchiveMarkerPath(
  stateDir: string = BOARD_ARCHIVE_STATE_DIR,
): string {
  return join(stateDir, BOARD_ARCHIVE_MARKER_FILE);
}

interface BoardArchiveMarker {
  readonly lastRunAt: string;
}

function readMarker(path: string): BoardArchiveMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const lastRunAt = (parsed as Record<string, unknown>).lastRunAt;
    if (typeof lastRunAt !== 'string') return null;
    isoTimestamp(lastRunAt);
    return { lastRunAt };
  } catch {
    // Missing file, unreadable, or malformed marker all fail open (treated
    // as "never run") — the worst case is one extra sweep attempt, not a
    // stuck throttle.
    return null;
  }
}

function writeMarker(path: string, marker: BoardArchiveMarker): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Pure throttle check: has enough time passed since `marker.lastRunAt` for
 * another sweep to run? Exported for direct unit testing without touching
 * the filesystem.
 */
export function shouldRunBoardArchiveSweep(
  marker: BoardArchiveMarker | null,
  now: Date,
  cooldownMs: number = BOARD_ARCHIVE_COOLDOWN_MS,
): boolean {
  if (marker === null) return true;
  const lastRunMs = Date.parse(marker.lastRunAt);
  if (!Number.isFinite(lastRunMs)) return true;
  return now.getTime() - lastRunMs >= cooldownMs;
}

function archiveMutation(projectId: string, itemIds: readonly string[]): string {
  const fields = itemIds
    .map((itemId, index) => (
      `  a${index}: archiveProjectV2Item(input: { projectId: "${projectId}", itemId: "${itemId}" }) {\n`
      + '    item { id }\n'
      + '  }'
    ))
    .join('\n');
  return `mutation {\n${fields}\n}`;
}

export interface BoardArchiveExecutorOptions {
  /** Defaults to the Jinn engineering Project's node id (`field-cache.ts`'s
   *  `PROJECT_ID`) when the caller has no snapshot-carried project id — the
   *  lean board snapshot doesn't expose one (see `board-archive.ts`). */
  readonly projectId?: string;
  readonly credential: SelectedCredential;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BoardArchiveExecutionResult {
  readonly archived: number;
  readonly capped: boolean;
}

/**
 * Archive the given board items via batched aliased
 * `archiveProjectV2Item` GraphQL mutations, `BOARD_ARCHIVE_BATCH_SIZE` per
 * request. Caps at `BOARD_ARCHIVE_MAX_PER_SWEEP`; any excess is silently
 * dropped for this call (the caller's next sweep picks up leftovers).
 * Uses the implementer credential, following the same
 * `withSelectedCredential` convention every other production executor in
 * this package uses (see `merge-executor-production.ts`,
 * `reconciliation-writer-production.ts`).
 */
export async function archiveBoardItems(
  itemIds: readonly string[],
  options: BoardArchiveExecutorOptions,
): Promise<BoardArchiveExecutionResult> {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const projectId = options.projectId ?? PROJECT_ID;
  const capped = itemIds.length > BOARD_ARCHIVE_MAX_PER_SWEEP;
  const toArchive = itemIds.slice(0, BOARD_ARCHIVE_MAX_PER_SWEEP);
  await withSelectedCredential(options.credential, ambient, async ({ run }) => {
    for (let offset = 0; offset < toArchive.length; offset += BOARD_ARCHIVE_BATCH_SIZE) {
      const batch = toArchive.slice(offset, offset + BOARD_ARCHIVE_BATCH_SIZE);
      await run('gh', ['api', 'graphql', '-f', `query=${archiveMutation(projectId, batch)}`]);
    }
  }, runner);
  return { archived: toArchive.length, capped };
}

export type BoardArchiveSweepResult =
  | { readonly status: 'archived'; readonly archived: number; readonly capped: boolean }
  | { readonly status: 'skipped-throttled' }
  | { readonly status: 'failed'; readonly reason: string };

export interface BoardArchiveSweepOptions {
  readonly snapshot: BoardArchiveProjectSnapshot;
  readonly now: Date;
  readonly credential: SelectedCredential;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly projectId?: string;
  /** Defaults to `boardArchiveMarkerPath()`; tests point this at a scratch
   *  directory instead of the real `~/.jinn-client` tree. */
  readonly markerPath?: string;
  readonly cooldownMs?: number;
}

/**
 * One sweep attempt: throttle check, plan, archive (capped), record the
 * marker. Never throws — a failure at any step (marker read/write, planning,
 * the GraphQL mutation calls) is caught and reported as `status: 'failed'`
 * so a bad sweep degrades the cycle's board hygiene, never the cycle itself
 * (jinn-mono#1883's zero-write-in-observe contract still holds: this
 * function is only ever wired into `recover`/`active` mode).
 *
 * The marker is written only on a completed (non-throttled, non-throwing)
 * attempt — including a zero-candidate outcome, which still "used" this
 * host's daily attempt. A failed attempt does *not* update the marker, so
 * the next cycle retries rather than waiting a full day to notice.
 */
export async function runBoardArchiveSweep(
  options: BoardArchiveSweepOptions,
): Promise<BoardArchiveSweepResult> {
  const markerPath = options.markerPath ?? boardArchiveMarkerPath();
  try {
    const marker = readMarker(markerPath);
    if (!shouldRunBoardArchiveSweep(marker, options.now, options.cooldownMs)) {
      return { status: 'skipped-throttled' };
    }
    const candidates = planBoardArchive(options.snapshot, options.now);
    const result: BoardArchiveExecutionResult = candidates.length === 0
      ? { archived: 0, capped: false }
      : await archiveBoardItems(candidates, {
          credential: options.credential,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        });
    writeMarker(markerPath, { lastRunAt: options.now.toISOString() });
    return { status: 'archived', archived: result.archived, capped: result.capped };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ProductionBoardArchiveSweepOptions {
  readonly credential: SelectedCredential;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly projectId?: string;
  readonly markerPath?: string;
  readonly cooldownMs?: number;
}

/**
 * Build the `(snapshot, now) => Promise<BoardArchiveSweepResult>` closure
 * `LifecycleControllerDeps.boardArchiveSweep` expects, wired with the
 * implementer credential — mirrors `makeProductionReconciliationWriter` /
 * `makeProductionActiveRuntime`'s factory shape in this package.
 */
export function makeProductionBoardArchiveSweep(
  options: ProductionBoardArchiveSweepOptions,
): (snapshot: GitHubLifecycleSnapshot, now: Date) => Promise<BoardArchiveSweepResult> {
  return (snapshot, now) => runBoardArchiveSweep({
    snapshot: snapshot.project,
    now,
    credential: options.credential,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.markerPath === undefined ? {} : { markerPath: options.markerPath }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  });
}
