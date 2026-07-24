import type { ProjectStatus } from '../dispatcher/types.js';

/**
 * Board-archive sweep planner (jinn-mono#1883): the "Jinn engineering"
 * GitHub Project board accumulates `Done` items forever unless something
 * archives them. GitHub archiving is reversible (the board's Archived items
 * view), not deletion — a wrongly-archived item is a one-click restore, so
 * the classification below can be conservative about *not* archiving
 * (leave it for a human/next sweep) without much downside, but should never
 * be wrong the other way (archiving something still live).
 *
 * Criteria: a board item archives when its Status is `Done` AND it is not
 * committed to the currently-active Sprint iteration — i.e. it has no
 * Sprint value at all, or its Sprint iteration id differs from the current
 * one. Comparison is always by iteration id, never by title (iteration
 * titles are human-editable and not unique across time).
 */
export interface BoardArchiveCandidateItem {
  /** The Project board item's node id (e.g. `PVTI_…`) — what
   *  `archiveProjectV2Item`'s `itemId` input expects. */
  readonly id: string;
  readonly status: ProjectStatus | null;
  /** Iteration id of the item's `Sprint` field value, or `null` when unset.
   *  Mirrors `SnapshotItem.sprintIterationId` in `dispatcher/project-snapshot.ts`. */
  readonly sprintIterationId: string | null;
}

/**
 * The planner's input shape. Structurally compatible with
 * `dispatcher/project-snapshot.ts`'s `ProjectSnapshot` (`items` +
 * `currentSprintIterationId`) — callers pass `GitHubLifecycleSnapshot.project`
 * directly. Narrowed to a local interface (rather than importing
 * `ProjectSnapshot`) so this module stays a small, dependency-light pure
 * function, matching the shape convention other reconciliation modules use
 * for their read-only snapshot inputs (e.g. `ReconciliationPullRequestNode`
 * in `reconciliation-writer-production.ts`).
 *
 * `currentSprintIterationId` is already resolved by
 * `dispatcher/project-snapshot.ts`'s `resolveCurrentSprintIterationId` at
 * snapshot-fetch time (using that call's injected `nowMs`, defaulting to
 * `Date.now()` only in production) — an iteration is "current" when
 * `startDate <= now < startDate + duration` days. A past iteration that has
 * rolled from the Sprint field's `iterations` list into
 * `completedIterations` simply stops being a candidate for
 * `currentSprintIterationId`, so an item whose stored `sprintIterationId`
 * still points at that now-completed iteration will never match the
 * (different) current one — it classifies as not-current and archives,
 * with no special-casing needed here for `completedIterations`.
 */
export interface BoardArchiveProjectSnapshot {
  readonly items: readonly BoardArchiveCandidateItem[];
  readonly currentSprintIterationId: string | null;
}

/**
 * Plan which board items to archive this sweep. Pure and deterministic:
 * same snapshot + `now` always yields the same item id list, in snapshot
 * order. `now` is validated (mirroring `deriveLifecycle`'s clock-injection
 * convention in `lifecycle.ts`) but not used to re-derive "current" —
 * `currentSprintIterationId` already reflects the snapshot's own injected
 * clock, and re-deriving it here from raw iteration configuration would
 * duplicate `resolveCurrentSprintIterationId` for no behavioral gain.
 *
 * Callers are responsible for throttling how often this runs and for
 * capping/batching the returned ids into archive mutations — see
 * `board-archive-executor-production.ts`.
 */
export function planBoardArchive(
  snapshot: BoardArchiveProjectSnapshot,
  now: Date,
): readonly string[] {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Invalid board-archive derivation time');
  }
  return snapshot.items
    .filter((item) => (
      item.status === 'Done'
      && (
        item.sprintIterationId === null
        || item.sprintIterationId !== snapshot.currentSprintIterationId
      )
    ))
    .map((item) => item.id);
}
