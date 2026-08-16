/**
 * `closePosting` — the requester lifecycle exit that reclaims a posted task's unused budget
 * (cutover stage-3 posting-flow plan; DR-2026-08-05 decision 1). One-swap M5d deferred this from
 * M5; it lands here as a PURE intent module: config-and-ports in, structured result out. The
 * `jinn tasks close` CLI verb is a separate front-end that resolves the venue lifecycle port and
 * calls this — the module itself reads no chain, opens no wallet, and imports nothing outside the
 * extractable work-client seam (see test/architecture/native-requester-work-client-boundary.test.ts).
 *
 * Generation honesty: the venue's `MarketplaceLifecyclePorts` are generation-conditional
 * (packages/marketplace/venue-base/src/writers/lifecycle.ts). The `today` generation the native
 * fleet runs against exposes only `refundUnusedTaskBudget` (reclaim escrow); the `revised`
 * generation exposes `closeTask`. This module prefers `closeTask` when the host wired it and falls
 * back to `refundUnusedTaskBudget`, so one call site serves both generations without the caller
 * knowing which is live. A port that carries neither is a `config`/`close-unsupported` refusal, not
 * a silent no-op.
 */
import type { MarketplaceLifecyclePorts } from '@jinn-network/marketplace-binding';
import { RequesterError } from '../errors.js';

/** The narrow lifecycle surface `closePosting` drives — the two close verbs plus announcement withdrawal. */
export type PostingClosePort = Pick<
  MarketplaceLifecyclePorts,
  'refundUnusedTaskBudget' | 'closeTask' | 'withdrawAnnouncement'
>;

export interface ClosePostingInput {
  readonly taskId: bigint;
  readonly port: PostingClosePort;
}

export interface ClosePostingResult {
  readonly verb: 'tasks close';
  readonly taskId: string;
  /** `closed` when the revised `closeTask` ran; `refunded` when the today `refundUnusedTaskBudget` ran. */
  readonly action: 'closed' | 'refunded';
  /** Whether the projector's append-only announcement retraction was requested (never a chain write). */
  readonly announcementWithdrawn: boolean;
}

function assertTaskId(taskId: bigint): void {
  if (taskId < 0n) {
    throw new RequesterError('config', 'invalid-task-id', `taskId must be a non-negative integer, received ${taskId}`);
  }
}

/**
 * Closes a posted task. Prefers the revised `closeTask`; falls back to the today
 * `refundUnusedTaskBudget`; refuses fail-closed when the host wired neither. Withdraws the
 * announcement first (a projector retraction, not a chain write) so a delivered-but-closed task
 * stops advertising before its budget is reclaimed.
 */
export async function closePosting(input: ClosePostingInput): Promise<ClosePostingResult> {
  assertTaskId(input.taskId);
  const { port } = input;
  let announcementWithdrawn = false;
  if (port.withdrawAnnouncement !== undefined) {
    await port.withdrawAnnouncement({ taskId: input.taskId });
    announcementWithdrawn = true;
  }
  if (port.closeTask !== undefined) {
    await port.closeTask({ taskId: input.taskId });
    return { verb: 'tasks close', taskId: input.taskId.toString(10), action: 'closed', announcementWithdrawn };
  }
  if (port.refundUnusedTaskBudget !== undefined) {
    await port.refundUnusedTaskBudget({ taskId: input.taskId });
    return { verb: 'tasks close', taskId: input.taskId.toString(10), action: 'refunded', announcementWithdrawn };
  }
  throw new RequesterError(
    'config',
    'close-unsupported',
    'the venue lifecycle port exposes neither closeTask nor refundUnusedTaskBudget; this chain generation has no close path',
  );
}
