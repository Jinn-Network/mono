/**
 * Board painter — pure Status derivation + paint/archive/orphan planning
 * for the single-surface lifecycle (Stage 3).
 *
 * The scheduled painter owns the Project Status *view*. Nothing in the
 * autopilot hot path consumes these values; drift is cosmetic and
 * self-corrects on the next paint. Spec:
 * `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md` §3.
 */

import type { ProjectStatus } from '../dispatcher/types.js';
import {
  planBoardArchive,
  type BoardArchiveCandidateItem,
  type BoardArchiveProjectSnapshot,
} from './board-archive.js';

/** Issue / PR labels that paint HUMAN and override every other predicate. */
export const HUMAN_HOLD_LABELS = [
  'autopilot:human',
  'review:needs-human',
] as const;

/**
 * Facts the painter reads. Deliberately narrower than full lifecycle
 * derivation — Status paint collapses many protocol states onto five
 * board columns (spec §3 mapping).
 */
export interface PaintFacts {
  /** Issue is still open on GitHub. */
  readonly issueOpen: boolean;
  /** Issue and/or open PR labels (union is fine). */
  readonly labels: readonly string[];
  /** Open draft PR linked to the issue. */
  readonly hasOpenDraftPr: boolean;
  /** Open non-draft PR linked to the issue. */
  readonly hasOpenNonDraftPr: boolean;
  /** Claim branch `autopilot/<N>` exists. */
  readonly hasClaimBranch: boolean;
  /** Linked PR is merged (issue typically auto-closes). */
  readonly merged: boolean;
  /** Open child issue targeting the parent PR (BLOCKED-BY-CHILD). */
  readonly hasOpenChildren: boolean;
}

export interface PaintBoardItem {
  /** Project board item node id (`PVTI_…`) for `gh project item-edit`. */
  readonly itemId: string;
  readonly issueNumber: number;
  readonly currentStatus: ProjectStatus | null;
  readonly facts: PaintFacts;
  /** Sprint iteration id for archive planning; null when unset. */
  readonly sprintIterationId?: string | null;
}

export interface StatusPaint {
  readonly itemId: string;
  readonly issueNumber: number;
  readonly from: ProjectStatus | null;
  readonly to: ProjectStatus;
}

export interface OrphanChildFact {
  readonly childIssueNumber: number;
  readonly parentPrNumber: number;
  /** Parent PR state from GitHub. */
  readonly parentState: 'open' | 'closed' | 'merged';
}

export interface OrphanChildClose {
  readonly childIssueNumber: number;
  readonly parentPrNumber: number;
  readonly reason: string;
}

export interface BoardPaintPlan {
  readonly paints: readonly StatusPaint[];
  /** Board item ids to archive (Done + not current sprint). */
  readonly archiveItemIds: readonly string[];
  readonly orphanCloses: readonly OrphanChildClose[];
}

function hasHumanHold(labels: readonly string[]): boolean {
  return HUMAN_HOLD_LABELS.some((label) => labels.includes(label));
}

/**
 * Map authoritative facts → Project Status per spec §3.
 *
 * | Protocol state                                      | Status       |
 * |-----------------------------------------------------|--------------|
 * | HUMAN (hold label)                                  | Human        |
 * | DONE (merged) / closed                              | Done         |
 * | DELIVERED / IN REVIEW / BLOCKED-BY-CHILD / MERGE-READY | In Review |
 * | CLAIMED / IN PROGRESS (draft PR or claim branch)    | In Progress  |
 * | ELIGIBLE                                            | Todo         |
 *
 * HUMAN overrides everything.
 */
export function derivePaintedStatus(facts: PaintFacts): ProjectStatus {
  if (hasHumanHold(facts.labels)) return 'Human';
  if (facts.merged || !facts.issueOpen) return 'Done';
  if (facts.hasOpenNonDraftPr || facts.hasOpenChildren) return 'In Review';
  if (facts.hasOpenDraftPr || facts.hasClaimBranch) return 'In Progress';
  return 'Todo';
}

/**
 * Emit Status edits only when the board column differs from the derived
 * paint. Pure and order-preserving.
 */
export function planStatusPaints(
  items: readonly PaintBoardItem[],
): readonly StatusPaint[] {
  const paints: StatusPaint[] = [];
  for (const item of items) {
    const to = derivePaintedStatus(item.facts);
    if (item.currentStatus === to) continue;
    paints.push({
      itemId: item.itemId,
      issueNumber: item.issueNumber,
      from: item.currentStatus,
      to,
    });
  }
  return paints;
}

/**
 * Plan orphan-close of children whose parent PR merged or closed.
 * The paint-board script executes the plan each sweep (Stage 3+4).
 */
export function planOrphanChildCloses(
  children: readonly OrphanChildFact[],
): readonly OrphanChildClose[] {
  const closes: OrphanChildClose[] = [];
  for (const child of children) {
    if (child.parentState === 'open') continue;
    closes.push({
      childIssueNumber: child.childIssueNumber,
      parentPrNumber: child.parentPrNumber,
      reason: child.parentState === 'merged'
        ? `Parent PR #${child.parentPrNumber} merged`
        : `Parent PR #${child.parentPrNumber} closed`,
    });
  }
  return closes;
}

/**
 * Full paint plan: Status diffs + stale-Done archive + orphan-close.
 * Archive reuses {@link planBoardArchive}; Status used for archive
 * classification is the *painted* (desired) Status so a freshly painted
 * Done item can archive in the same sweep when sprint rules allow.
 */
export function planBoardPaint(
  items: readonly PaintBoardItem[],
  orphanChildren: readonly OrphanChildFact[],
  currentSprintIterationId: string | null,
  now: Date,
): BoardPaintPlan {
  const paints = planStatusPaints(items);
  const desiredByItemId = new Map(
    paints.map((paint) => [paint.itemId, paint.to] as const),
  );
  const archiveItems: BoardArchiveCandidateItem[] = items.map((item) => ({
    id: item.itemId,
    status: desiredByItemId.get(item.itemId) ?? item.currentStatus,
    sprintIterationId: item.sprintIterationId ?? null,
  }));
  const archiveSnapshot: BoardArchiveProjectSnapshot = {
    items: archiveItems,
    currentSprintIterationId,
  };
  return {
    paints,
    archiveItemIds: planBoardArchive(archiveSnapshot, now),
    orphanCloses: planOrphanChildCloses(orphanChildren),
  };
}
