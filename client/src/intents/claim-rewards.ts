/**
 * Claim-rewards intent module.
 *
 * Per spec §4.1 (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md),
 * a control route is a thin front-end over a PURE intent module: config +
 * signer + store in, structured result out. No `CommandContext`, no argv
 * parsing, no `checkDaemonGuard` — the daemon-guard is a property of the CLI
 * front-end alone (it exists to stop a standalone CLI process racing the
 * live daemon; a route running *inside* the daemon has nothing to guard
 * against).
 *
 * This is the first intent extracted and the template for the rest of the
 * §4.2 disposition table. Three front-ends call it — the CLI verb
 * (`cli/commands/claim-rewards.ts`), the HTTP route (`api/admin-endpoint.ts`),
 * and the periodic loop (`daemon/reward-claim-loop.ts`) — and none of them
 * invoke each other; they all converge here. `daemon → intents` is the
 * correct import direction for shared core logic; the reverse (as this
 * module originally shipped, importing the tick from `daemon/`) is
 * backwards, so the tick + record logic lives here now.
 *
 * The tick + record logic is otherwise deterministic given its inputs and
 * the chain state observed at call time; `generatedAt` (a wall-clock read)
 * on the returned envelope is the sole impurity.
 */

import type { PublicClient, WalletClient } from 'viem';
import type { FleetStateStore } from '../earning/store.js';
import type { Store } from '../store/store.js';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
  type StolasClaimTickResult,
} from '../earning/stolas-claim.js';
import type { FleetState } from '../earning/types.js';
import { emitEvent } from '../observability/emit-event.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';

export interface ClaimRewardsIntentInput {
  publicClient: PublicClient;
  /** Master EOA — same signer as distributor.stake() in bootstrap (pays gas). */
  masterWallet: WalletClient;
  fleetStore: FleetStateStore;
  chain: 'base' | 'base-sepolia';
  /** Resolved from getChainConfig (artifact overrides). */
  distributorAddress: string | undefined;
  /** When true, per-service claim failures throw instead of being swallowed. The daemon loop omits this. */
  strict?: boolean;
  /**
   * Jinn activity/event store. Injected, not opened here — callers own the
   * open/close lifecycle (the CLI opens a fresh handle per invocation; the
   * daemon route and loop reuse the daemon's already-open, longer-lived
   * handle). Optional only because the loop's config allows a Store-less
   * mode (no heartbeat surface); when absent, the tick still runs but
   * nothing is recorded.
   */
  jinnStore?: Store;
  /**
   * Which front-end triggered this claim — recorded on the emitted log
   * line. The CLI passes `'claim-rewards'`, the admin HTTP route passes
   * `'admin-route'`, the periodic loop passes `'reward-claim'`.
   */
  source: string;
}

export interface ClaimRewardsIntentResult {
  schemaVersion: 1;
  generatedAt: string;
  verb: 'claim-rewards';
  attempted: number;
  submitted: number;
  skippedNoPending: number;
  skippedNoDistributor: boolean;
  skippedWrongMode: boolean;
  claimAttempted: number;
  failedRecoverable: number;
  failedPermanent: number;
  claims: StolasClaimTickResult['claims'];
}

function recordRewardClaimResult(
  jinnStore: Store,
  state: FleetState,
  result: StolasClaimTickResult,
  distributorAddress: string | undefined,
  source: string,
): void {
  if (result.claims.length === 0) return;
  const serviceByStakingId = new Map<number, (typeof state.services)[number]>();
  for (const svc of state.services) {
    if (svc.service_id != null) serviceByStakingId.set(svc.service_id, svc);
  }
  for (const claim of result.claims) {
    const svc = serviceByStakingId.get(claim.serviceId);
    if (!svc) continue;
    const serviceIndex = displayFleetServiceIndex(svc);
    jinnStore.recordRewardClaim({
      ts: new Date().toISOString(),
      serviceIndex,
      serviceId: claim.serviceId,
      stakingProxy: claim.stakingProxy,
      distributor: distributorAddress ?? '0x',
      txHash: claim.txHash,
      amountWei: claim.amountWei,
    });
    emitEvent(jinnStore, {
      kind: 'reward_claimed',
      serviceIndex,
      txHash: claim.txHash,
      outcome: 'ok',
      detail: `Submitted distributor.claim for service ${claim.serviceId} (pre-split queue: ${claim.amountWei} wei; operator collector-slot share only)`,
    }, source);
  }
}

async function runTick(input: ClaimRewardsIntentInput): Promise<ClaimRewardsIntentResult> {
  const state = await input.fleetStore.load(input.chain);
  const targets = listStolasClaimTargets(state.services);
  const tick = await tickStolasDistributorClaims(input.publicClient, input.masterWallet, {
    distributorAddress: input.distributorAddress,
    stakingMode: state.staking_mode,
    targets,
    strict: input.strict,
  });

  if (input.jinnStore && tick.claims.length > 0) {
    const latestState = await input.fleetStore.load(input.chain);
    recordRewardClaimResult(input.jinnStore, latestState, tick, input.distributorAddress, input.source);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'claim-rewards',
    attempted: tick.attempted,
    submitted: tick.submitted,
    skippedNoPending: tick.skippedNoPending,
    skippedNoDistributor: tick.skippedNoDistributor,
    skippedWrongMode: tick.skippedWrongMode,
    claimAttempted: tick.claimAttempted,
    failedRecoverable: tick.failedRecoverable,
    failedPermanent: tick.failedPermanent,
    claims: tick.claims,
  };
}

// Module-level single-flight queue (not per-input — one daemon, one signing
// EOA, one queue, no matter how many front-ends call in). WHY THIS EXISTS:
// `tickStolasDistributorClaims` (earning/stolas-claim.ts) pre-reads
// `calculateStakingReward` for each target, THEN broadcasts
// `distributor.claim`. The nonce lock inside the send path
// (`withEoaBroadcastLock`, tx-retry.ts:865,1092-1103) already serializes the
// actual sends for a given EOA — but not the pre-read. Two ticks racing this
// function (a double-click on the dashboard's claim button, the MCP tool
// firing beside the SPA, a proxy retrying a POST, or the periodic loop
// landing beside a manual claim) can both read the same non-zero pending
// balance before either sends; the nonce lock then serializes the sends
// themselves, so the first send succeeds and zeroes the reward, and the
// second's now-stale send reverts on-chain — burning gas, and (under
// `strict: true`, i.e. every front-end but the loop) surfacing a failure
// response for a claim that actually succeeded.
//
// The fix is to serialize the WHOLE tick, not just the send: every call
// queues behind whichever tick is currently running (`.catch(() => {})`
// only swallows a previous tick's rejection for chaining purposes — this
// call's own rejection still propagates to its own caller via the awaited
// `runPromise` below). By the time a queued tick's pre-read actually runs,
// any prior tick's sends have already landed on-chain, so the pre-read
// observes accurate state and the race can't recur. `inFlight` is cleared
// back to idle only if it still points at the run that just finished — the
// standard promise-chain mutex idiom, so a call that arrives after a newer
// call has already re-queued doesn't clobber that newer call's tail.
//
// Deliberately NOT `withEoaBroadcastLock`: that lock is non-reentrant, and
// `tickStolasDistributorClaims`'s own send path takes it (for the same EOA)
// on every claim — wrapping the whole tick in it would have the tick
// deadlock against its own inner send.
let inFlight: Promise<ClaimRewardsIntentResult> | undefined;

/**
 * Runs one reward-claim tick (queued behind any tick already in flight) and
 * records any resulting claims. Throws on transport/RPC failure under
 * `strict: true` — front-ends decide how to shape that into their own error
 * surface (CLI envelope vs. HTTP JSON error); the loop omits `strict` and
 * never throws for per-service failures.
 */
export async function claimRewardsIntent(
  input: ClaimRewardsIntentInput,
): Promise<ClaimRewardsIntentResult> {
  const previous = inFlight ?? Promise.resolve();
  const runPromise = previous.catch(() => {}).then(() => runTick(input));
  inFlight = runPromise;
  try {
    return await runPromise;
  } finally {
    if (inFlight === runPromise) inFlight = undefined;
  }
}
