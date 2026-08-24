import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AERO_ADDR } from '../../_protocols.js';
import { AERO, createLockAndMaybeVote } from '../../_aero.js';

/** Reference: 1-year lock, full-weight vote for the CL50 gen-3 pool (canonical by emissions votes). */
export async function solve(ctx: FixtureCtx): Promise<void> {
  await createLockAndMaybeVote(ctx, {
    aero: AERO(1000),
    durationSec: 365n * 24n * 3600n,
    votePool: AERO_ADDR.poolCl50Gen3,
  });
}
