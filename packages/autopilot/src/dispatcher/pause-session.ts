/**
 * Wall-clock circuit-breaker (spec §4): pause an in-flight session whose
 * wall-clock ceiling has elapsed by setting the issue's "Blocked on" Project
 * field to "Human".
 *
 * Pre-#599 `pauseSession` lived inline in `scripts/run-autopilot.ts` and did
 * its own `gh project item-list --limit 500` per pause to resolve the project
 * item id for the issue number. That call is gone — the per-cycle
 * `ProjectSnapshot` already carries every item's `PVTI_…` id (see
 * `project-snapshot.ts:88–109`), so the orchestrator hands the snapshot down
 * and a per-cycle closure does the lookup in-memory.
 *
 * Tracking: jinn-mono#599.
 */

import type { FieldCache } from './field-cache.js';
import type {
  CommandRunner,
  ProjectSnapshot,
} from './project-snapshot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger surface — defaults to `console`. Injectable so tests
 *  can capture without polluting the test output stream. */
export interface PauseSessionLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a per-cycle pause function over the cycle's snapshot + the boot-time
 * field cache. The returned function looks up the project item id from the
 * snapshot (filtering on `contentType === 'Issue'` so a same-numbered linked
 * PR doesn't shadow the Issue), then sets "Blocked on" to "Human" via
 * `gh project item-edit`.
 *
 * The error log when an issue is absent from the snapshot is an
 * operator-visible line — preserve wording for log-stability across releases,
 * as downstream consumers (alerting, log scrapers) may key off the substring.
 */
export function makePauseSession(
  snapshot: ProjectSnapshot,
  fieldCache: FieldCache,
  runner: CommandRunner,
  logger: PauseSessionLogger = console,
): (issueNumber: number) => Promise<void> {
  // Build the lookup once per cycle, not per pause. Filter to Issue items
  // so a linked PullRequest with the same number cannot win the lookup.
  const itemIdByIssueNumber = new Map<number, string>();
  for (const item of snapshot.items) {
    if (item.contentType === 'Issue') {
      itemIdByIssueNumber.set(item.number, item.id);
    }
  }

  return async (issueNumber: number): Promise<void> => {
    logger.log(
      `[autopilot] WALL-CLOCK EXPIRED — pausing session for issue #${issueNumber} (Blocked on: Human)`,
    );

    const itemId = itemIdByIssueNumber.get(issueNumber);
    if (itemId == null) {
      // Operator-visible log line — preserve wording for log-stability
      // across releases.
      logger.error(
        `[autopilot] pauseSession: issue #${issueNumber} not found in project board — cannot set Blocked on: Human`,
      );
      return;
    }

    await runner('gh', [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', fieldCache.projectId,
      '--field-id', fieldCache.blockedOn.fieldId,
      '--single-select-option-id', fieldCache.blockedOn.options.Human,
    ]);

    logger.log(
      `[autopilot] issue #${issueNumber} set to Blocked on: Human (wall-clock ceiling exceeded).`,
    );
  };
}
