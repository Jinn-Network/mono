/**
 * Two-layer claim orchestration for the harness engine.
 *
 * §6.1, §9.1, §9.2 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Layer 1: ClaimRegistry claim — Jinn's work-coordination contract.
 * Layer 2: Marketplace priority claim — calls MechAdapter.claimRequest() to
 *   register the priority-mech exclusivity window (300 s responseTimeout).
 *
 * The ClaimRegistry claimTTL is owner-configured per-deployment and is not
 * passed by the client.
 *
 * Recovery:
 *   On resume, ClaimRegistryClient.weAlreadyClaimed() is checked before any
 *   on-chain write.  If we already hold the claim, the ClaimRegistry step is
 *   skipped entirely.  The marketplace claim is re-attempted because it is
 *   stateless from the engine's perspective (MechAdapter is idempotent there).
 *
 * Failure modes:
 *   - ClaimRegistry claim fails → throw, no marketplace call, engine marks FAILED.
 *   - Marketplace claim fails → release ClaimRegistry claim, throw.
 */

import type { Hex } from 'viem';
import type { ClaimRegistryClient } from '../../adapters/claim-registry/client.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

/**
 * Minimal interface for the marketplace adapter's claim path.
 * The full MechAdapter satisfies this; tests can inject a stub.
 */
export interface MarketplaceClaimer {
  claimRequest(requestId: string): Promise<void>;
}

/**
 * Parameters describing a single task's timing window.
 * Extracted from PersistedTaskRun for testability (no DB dependency).
 */
export interface ClaimWindow {
  requestId: string;
  /** Window start timestamp in ms (epoch). Used for graceful release decision. */
  windowStartTs: number;
}

/** Result of a successful two-layer claim. */
export interface ClaimResult {
  /** True if the ClaimRegistry claim was freshly placed (false = pre-existing). */
  registryClaimWasFresh: boolean;
}

// ── Two-layer claim ───────────────────────────────────────────────────────────

/**
 * Execute the two-layer claim for a single task.
 *
 * // Claim ordering: ClaimRegistry FIRST (cheap coordination lock), marketplace SECOND.
 * // Spec §6.1 lists them in opposite order but doesn't enforce sequencing — registry-first
 * // is preferred because: (a) ClaimRegistry revert is fast and signals "another harness
 * // is on it" cleanly; (b) marketplace claim is more expensive (Safe tx + actual gas);
 * // (c) we release ClaimRegistry on marketplace failure to avoid leaking a stale claim.
 *
 * @param claimWindow - Timing data for the task (requestId, windowStartTs).
 * @param registryClient - ClaimRegistryClient for the deployed ClaimRegistry contract.
 * @param marketplaceClaimer - Adapter whose claimRequest() performs the marketplace claim.
 * @returns ClaimResult on success.
 * @throws If either layer cannot be claimed (after graceful cleanup).
 */
export async function executeTwoLayerClaim(
  claimWindow: ClaimWindow,
  registryClient: ClaimRegistryClient,
  marketplaceClaimer: MarketplaceClaimer,
): Promise<ClaimResult> {
  const requestIdHex = claimWindow.requestId as Hex;

  // ── Layer 1: ClaimRegistry ────────────────────────────────────────────────

  // Idempotency check: if we already hold the claim, skip the on-chain write.
  const alreadyClaimed = await registryClient.weAlreadyClaimed(requestIdHex);
  let registryClaimWasFresh = false;

  if (!alreadyClaimed) {
    const result = await registryClient.claimJob(requestIdHex);
    if (!result.claimed) {
      const detail =
        result.reason === 'lost-race' && result.competitor
          ? `lost claim race to ${result.competitor}`
          : result.reason === 'lost-race'
            ? 'lost claim race to another operator'
            : result.reason === 'ineligible'
              ? 'eligibility checker rejected'
              : `tx reverted${result.reason ? ` (${result.reason})` : ''}`;
      throw new Error(
        `[claim-orchestration] ClaimRegistry claim failed for ${claimWindow.requestId} — ${detail}`,
      );
    }
    registryClaimWasFresh = true;
  } else {
    console.log(
      `[claim-orchestration] ClaimRegistry: pre-existing claim found for ${claimWindow.requestId}, skipping re-claim`,
    );
  }

  // ── Layer 2: Marketplace ──────────────────────────────────────────────────

  try {
    await marketplaceClaimer.claimRequest(claimWindow.requestId);
  } catch (marketplaceErr) {
    // Marketplace claim failed — release the ClaimRegistry claim we just placed
    // (only if we placed it fresh; pre-existing claims are not ours to release here)
    // TODO(v0 trade-off): on the resume path (weAlreadyClaimed = true, registryClaimWasFresh = false)
    // we do NOT release the ClaimRegistry claim here.  Releasing on a transient marketplace failure
    // would forfeit our coordination lock and let a competing harness take it.  The downside is that
    // on a *persistent* failure the claim sits locked until TTL expiry (owner-configured per-deployment).
    // Distinguishing transient vs. permanent failures is non-trivial; for v0 we accept the TTL wait.
    // Future: inspect the marketplace error type and release only on permanent failures.
    if (registryClaimWasFresh) {
      try {
        await registryClient.releaseClaim(requestIdHex);
        console.log(
          `[claim-orchestration] released ClaimRegistry claim for ${claimWindow.requestId} after marketplace failure`,
        );
      } catch (releaseErr) {
        const releaseMsg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        console.error(
          `[claim-orchestration] failed to release ClaimRegistry claim for ${claimWindow.requestId} after marketplace failure: ${releaseMsg}`,
        );
      }
    }
    throw marketplaceErr;
  }

  return { registryClaimWasFresh };
}

// ── Graceful release ──────────────────────────────────────────────────────────

/**
 * Release the ClaimRegistry claim for an task that was CLAIMED but whose
 * work window has not yet started (windowStartTs not reached).
 *
 * Used during graceful engine shutdown. No-op if we don't hold the claim.
 *
 * @returns true if the claim was released, false if there was nothing to release.
 */
export async function releaseClaimedNotStarted(
  claimWindow: ClaimWindow,
  registryClient: ClaimRegistryClient,
): Promise<boolean> {
  const requestIdHex = claimWindow.requestId as Hex;

  // Only release if the work window hasn't started yet
  if (Date.now() >= claimWindow.windowStartTs) {
    console.log(
      `[claim-orchestration] NOT releasing claim for ${claimWindow.requestId} — window already started`,
    );
    return false;
  }

  const released = await registryClient.releaseClaim(requestIdHex);
  if (released) {
    console.log(
      `[claim-orchestration] released ClaimRegistry claim for ${claimWindow.requestId} (graceful shutdown, before window start)`,
    );
  }
  return released;
}
