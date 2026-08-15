/**
 * `releasePostedAttempt` — the operator-side lifecycle exit that releases a claimed-but-unworked
 * attempt back to the pool (cutover stage-3 posting-flow plan; DR-2026-08-05 decision 1). One-swap
 * M5d deferred this from M5; it lands as a PURE intent module (config-and-ports in, structured
 * result out). The `jinn tasks release` CLI verb is a separate front-end.
 *
 * Generation honesty: `ReleaseAttemptPort.releaseAttempt` broadcasts on the `revised` generation
 * but returns `{ ok: false, kind: 'unsupported' }` on the `today` generation the native fleet runs
 * against (packages/marketplace/venue-base/src/writers/lifecycle.ts). This module surfaces that as
 * a first-class `unsupported` outcome rather than a throw, so the CLI can report it plainly. The
 * `unreleased_attempt` operator notification kind — whose producer has been dead precisely because
 * no release path existed — is only reachable once a `revised`-generation release actually
 * broadcasts; wiring that producer is out of scope on the today generation (see the M5d PR body
 * finding), so this module does not fabricate it.
 */
import type { ReleaseAttemptPort } from '@jinn-network/marketplace-binding';
import { RequesterError } from '../errors.js';

export interface ReleasePostedAttemptInput {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly port: Pick<ReleaseAttemptPort, 'releaseAttempt'>;
}

export interface ReleasePostedAttemptResult {
  readonly verb: 'tasks release';
  readonly taskId: string;
  readonly attemptIndex: number;
  /** `released` when the chain write ran; `unsupported` on a generation with no on-chain release. */
  readonly outcome: 'released' | 'unsupported';
}

/**
 * Releases one posted attempt. Returns `unsupported` (not a throw) when the wired generation has no
 * on-chain release, so the caller distinguishes "this chain cannot release" from a real failure.
 */
export async function releasePostedAttempt(
  input: ReleasePostedAttemptInput,
): Promise<ReleasePostedAttemptResult> {
  if (input.taskId < 0n) {
    throw new RequesterError('config', 'invalid-task-id', `taskId must be a non-negative integer, received ${input.taskId}`);
  }
  if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0) {
    throw new RequesterError(
      'config',
      'invalid-attempt-index',
      `attemptIndex must be a non-negative integer, received ${input.attemptIndex}`,
    );
  }
  const result = await input.port.releaseAttempt({ taskId: input.taskId, attemptIndex: input.attemptIndex });
  const unsupported = result !== undefined && result !== null && result.ok === false && result.kind === 'unsupported';
  return {
    verb: 'tasks release',
    taskId: input.taskId.toString(10),
    attemptIndex: input.attemptIndex,
    outcome: unsupported ? 'unsupported' : 'released',
  };
}
