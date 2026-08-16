/**
 * `cancelAttempt` — the requester lifecycle exit that persists a durable cancel signal for one
 * in-flight attempt (cutover stage-3 posting-flow plan; DR-2026-08-05 decision 1). One-swap M5d
 * deferred this from M5; it lands as a PURE intent module (config-and-ports in, structured result
 * out). The `jinn tasks cancel` CLI verb is a separate front-end.
 *
 * The signal IS the row: `MarketplaceLifecyclePorts.requestCancel` writes it to the venue's
 * `cancel_signals` table (packages/marketplace/venue-base/src/writers/lifecycle.ts), and a
 * restart/replay reads it back as `already-requested` rather than emitting a second one. This is
 * NOT an on-chain attempt cancellation — the today generation has no such op — so the module's
 * result names the signal, never claims the attempt was torn down on chain.
 */
import type { MarketplaceLifecyclePorts } from '@jinn-network/marketplace-binding';
import { RequesterError } from '../errors.js';

/** The narrow lifecycle surface `cancelAttempt` drives — attempt resolution plus the durable signal. */
export type AttemptCancelPort = Pick<MarketplaceLifecyclePorts, 'resolveAttempt' | 'requestCancel'>;

export interface CancelAttemptInput {
  /** The attempt URN (`urn:uuid:...`) the requester wants cancelled. */
  readonly attempt: `urn:uuid:${string}`;
  readonly reason: string;
  readonly port: AttemptCancelPort;
}

export interface CancelAttemptResult {
  readonly verb: 'tasks cancel';
  readonly attempt: `urn:uuid:${string}`;
  readonly taskId: string;
  readonly attemptIndex: number;
  /** `requested` on the first signal; `already-requested` when a prior signal is durably present. */
  readonly signal: 'requested' | 'already-requested';
}

const ATTEMPT_URN = /^urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/**
 * Resolves the attempt to its `(taskId, attemptIndex)` and persists the requester's cancel signal.
 * Idempotent by construction: the port returns `already-requested` without emitting a duplicate.
 */
export async function cancelAttempt(input: CancelAttemptInput): Promise<CancelAttemptResult> {
  if (!ATTEMPT_URN.test(input.attempt)) {
    throw new RequesterError('config', 'invalid-attempt', `attempt must be a urn:uuid, received ${input.attempt}`);
  }
  if (input.reason.trim().length === 0) {
    throw new RequesterError('config', 'invalid-reason', 'cancel reason must be a non-empty string');
  }
  const resolved = await input.port.resolveAttempt(input.attempt);
  const signal = await input.port.requestCancel({
    attempt: input.attempt,
    taskId: resolved.taskId,
    attemptIndex: resolved.attemptIndex,
    reason: input.reason,
  });
  return {
    verb: 'tasks cancel',
    attempt: input.attempt,
    taskId: resolved.taskId.toString(10),
    attemptIndex: resolved.attemptIndex,
    signal,
  };
}
