import type { CommandRunner, ProjectSnapshot, SnapshotItem } from './project-snapshot.js';
import type { FieldCache } from './field-cache.js';

async function setStatus(
  item: SnapshotItem,
  fieldCache: FieldCache,
  runner: CommandRunner,
  optionId: string,
): Promise<void> {
  await runner('gh', [
    'project', 'item-edit',
    '--id', item.id,
    '--project-id', fieldCache.projectId,
    '--field-id', fieldCache.status.fieldId,
    '--single-select-option-id', optionId,
  ]);
}

/**
 * Keep the `Human` Status lane a faithful mirror of "blocked on a human".
 *
 * The lane is the operator's single "needs my eyes" view. Each cycle:
 *
 *  - **Promote** — any issue that is `Blocked on: Human` and still sitting in a
 *    pre-handoff column (`Todo` backlog gated on a human, or an `In Progress`
 *    session that escalated) is moved to Status `Human`. There is no parked
 *    Status the escalating actor can set without the option id, so the
 *    dispatcher does it; this covers wall-clock and in-session escalations
 *    uniformly. `Done` / `In Review` are left alone (a stale block marker on a
 *    closed issue is not an open escalation; a PR in review is already in its
 *    own lane).
 *
 *  - **Demote** — any issue parked in the `Human` lane that is no longer
 *    `Blocked on: Human` is returned to `Todo`, so clearing the block re-readies
 *    it for dispatch. Without this, unblocking a lane item would strand it
 *    forever (Status `Human` never satisfies `selectReady`, which requires
 *    `Todo`). `Todo` is the universal re-dispatch target — an escalation that is
 *    resolved gets re-attempted by a fresh session carrying the human's input.
 *
 * Status `Human` is therefore dispatcher-managed: it tracks the `Blocked on`
 * field, not a manual move. Infra-side and idempotent (a correctly-parked item
 * matches neither rule). Per-item failures are isolated and logged, never fatal.
 *
 * Returns the issue numbers moved in each direction (for the cycle log).
 */
export async function syncHumanLane(
  snapshot: ProjectSnapshot,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<{ promoted: number[]; demoted: number[] }> {
  const humanOptionId = fieldCache.status.options.Human;
  const todoOptionId = fieldCache.status.options.Todo;
  const promoted: number[] = [];
  const demoted: number[] = [];

  for (const item of snapshot.items) {
    if (item.contentType !== 'Issue') continue;

    if (item.blockedOn === 'Human' && (item.status === 'Todo' || item.status === 'In Progress')) {
      try {
        await setStatus(item, fieldCache, runner, humanOptionId);
        promoted.push(item.number);
      } catch (err) {
        console.error(`[autopilot] could not promote #${item.number} to Status: Human (continuing):`, err);
      }
      continue;
    }

    if (item.status === 'Human' && item.blockedOn !== 'Human') {
      try {
        await setStatus(item, fieldCache, runner, todoOptionId);
        demoted.push(item.number);
      } catch (err) {
        console.error(`[autopilot] could not demote #${item.number} out of Status: Human (continuing):`, err);
      }
    }
  }

  return { promoted, demoted };
}
