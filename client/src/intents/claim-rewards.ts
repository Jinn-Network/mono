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
 * §4.2 disposition table. The CLI verb (`cli/commands/claim-rewards.ts`) and
 * the HTTP route (`api/admin-endpoint.ts`) are both non-invoking front-ends
 * over this module — neither invokes the other.
 */

import type { PublicClient, WalletClient } from 'viem';
import type { FleetStateStore } from '../earning/store.js';
import type { Store } from '../store/store.js';
import { recordRewardClaimResult, runRewardClaimOnce } from '../daemon/reward-claim-loop.js';
import type { StolasClaimTickResult } from '../earning/stolas-claim.js';

export interface ClaimRewardsIntentInput {
  publicClient: PublicClient;
  /** Master EOA — same signer as distributor.stake() in bootstrap (pays gas). */
  masterWallet: WalletClient;
  fleetStore: FleetStateStore;
  chain: 'base' | 'base-sepolia';
  /** Resolved from getChainConfig (artifact overrides). */
  distributorAddress: string | undefined;
  /** When true, per-service claim failures throw instead of being swallowed. */
  strict?: boolean;
  /**
   * Jinn activity/event store. Injected, not opened here — callers own the
   * open/close lifecycle (the CLI opens a fresh handle per invocation; the
   * daemon route reuses its already-open, longer-lived handle).
   */
  jinnStore: Store;
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

/**
 * Runs one reward-claim tick and records any resulting claims. Throws on
 * transport/RPC failure — front-ends decide how to shape that into their own
 * error surface (CLI envelope vs. HTTP JSON error).
 */
export async function claimRewardsIntent(
  input: ClaimRewardsIntentInput,
): Promise<ClaimRewardsIntentResult> {
  const tick = await runRewardClaimOnce({
    publicClient: input.publicClient,
    masterWallet: input.masterWallet,
    store: input.fleetStore,
    chain: input.chain,
    distributorAddress: input.distributorAddress,
    strict: input.strict ?? true,
  });

  if (tick.claims.length > 0) {
    const latestState = await input.fleetStore.load(input.chain);
    recordRewardClaimResult(
      input.jinnStore,
      latestState,
      tick,
      input.distributorAddress,
      'claim-rewards',
    );
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
