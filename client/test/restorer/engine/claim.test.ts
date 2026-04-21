/**
 * Unit tests for claim orchestration (claim.ts).
 * All deps are injected as stubs — no real chain, no real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeTwoLayerClaim,
  releaseClaimedNotStarted,
  type ClaimWindow,
  type MarketplaceClaimer,
} from '../../../src/restorer/engine/claim.js';
import type { ClaimRegistryClient } from '../../../src/adapters/claim-registry/client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = Date.now();

function makeWindow(overrides: Partial<ClaimWindow> = {}): ClaimWindow {
  return {
    requestId: '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
    windowStartTs: NOW + 60_000,        // 1 min in the future
    ...overrides,
  };
}

function makeRegistryClient(overrides: Partial<{
  weAlreadyClaimed: boolean;
  claimResult: { txHash: string; claimed: boolean };
  releaseResult: boolean;
}>): ClaimRegistryClient {
  return {
    weAlreadyClaimed: vi.fn().mockResolvedValue(overrides.weAlreadyClaimed ?? false),
    claimJob: vi.fn().mockResolvedValue(
      overrides.claimResult ?? { txHash: '0xabc', claimed: true }
    ),
    releaseClaim: vi.fn().mockResolvedValue(overrides.releaseResult ?? true),
    getJobClaim: vi.fn().mockResolvedValue({ claimer: '0x0', expiresAt: 0n, isActive: false }),
    expireClaim: vi.fn().mockResolvedValue(true),
  } as unknown as ClaimRegistryClient;
}

function makeMarketplaceClaimer(failWith?: Error): MarketplaceClaimer {
  if (failWith) {
    return {
      claimRequest: vi.fn().mockRejectedValue(failWith),
    };
  }
  return {
    claimRequest: vi.fn().mockResolvedValue(undefined),
  };
}

// ── executeTwoLayerClaim ──────────────────────────────────────────────────────

describe('executeTwoLayerClaim', () => {
  it('calls claimJob and claimRequest in order when no pre-existing claim', async () => {
    const registry = makeRegistryClient({ claimResult: { txHash: '0xabc', claimed: true } });
    const marketplace = makeMarketplaceClaimer();

    const result = await executeTwoLayerClaim(makeWindow(), registry, marketplace);

    expect(registry.weAlreadyClaimed).toHaveBeenCalledOnce();
    expect(registry.claimJob).toHaveBeenCalledOnce();
    expect(marketplace.claimRequest).toHaveBeenCalledOnce();
    expect(result.registryClaimWasFresh).toBe(true);
  });

  it('skips claimJob when weAlreadyClaimed is true (idempotent resume)', async () => {
    const registry = makeRegistryClient({ weAlreadyClaimed: true });
    const marketplace = makeMarketplaceClaimer();

    const result = await executeTwoLayerClaim(makeWindow(), registry, marketplace);

    expect(registry.claimJob).not.toHaveBeenCalled();
    expect(marketplace.claimRequest).toHaveBeenCalledOnce();
    expect(result.registryClaimWasFresh).toBe(false);
  });

  it('throws when ClaimRegistry claim fails (claimed=false)', async () => {
    const registry = makeRegistryClient({ claimResult: { txHash: '', claimed: false } });
    const marketplace = makeMarketplaceClaimer();

    await expect(
      executeTwoLayerClaim(makeWindow(), registry, marketplace)
    ).rejects.toThrow(/ClaimRegistry claim failed/);

    // Marketplace should NOT be called if registry fails
    expect(marketplace.claimRequest).not.toHaveBeenCalled();
  });

  it('releases ClaimRegistry claim and rethrows when marketplace fails', async () => {
    const registry = makeRegistryClient({ claimResult: { txHash: '0xabc', claimed: true } });
    const marketplace = makeMarketplaceClaimer(new Error('Claim policy rejected'));

    await expect(
      executeTwoLayerClaim(makeWindow(), registry, marketplace)
    ).rejects.toThrow('Claim policy rejected');

    // ClaimRegistry claim should have been released
    expect(registry.releaseClaim).toHaveBeenCalledOnce();
  });

  it('does NOT release pre-existing ClaimRegistry claim when marketplace fails', async () => {
    // weAlreadyClaimed=true means we didn't freshly place the claim
    const registry = makeRegistryClient({ weAlreadyClaimed: true });
    const marketplace = makeMarketplaceClaimer(new Error('marketplace down'));

    await expect(
      executeTwoLayerClaim(makeWindow(), registry, marketplace)
    ).rejects.toThrow('marketplace down');

    // Since claim was pre-existing (not fresh), we should NOT release
    expect(registry.releaseClaim).not.toHaveBeenCalled();
  });

  it('still throws marketplace error even if releaseClaim also fails', async () => {
    const registry = makeRegistryClient({ claimResult: { txHash: '0xabc', claimed: true } });
    (registry.releaseClaim as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('release failed'));
    const marketplace = makeMarketplaceClaimer(new Error('marketplace error'));

    // Should throw the original marketplace error, not the release error
    await expect(
      executeTwoLayerClaim(makeWindow(), registry, marketplace)
    ).rejects.toThrow('marketplace error');
  });
});

// ── releaseClaimedNotStarted ──────────────────────────────────────────────────

describe('releaseClaimedNotStarted', () => {
  it('releases claim when window has not started yet', async () => {
    const registry = makeRegistryClient({ releaseResult: true });
    const window = makeWindow({ windowStartTs: Date.now() + 60_000 });

    const released = await releaseClaimedNotStarted(window, registry);

    expect(released).toBe(true);
    expect(registry.releaseClaim).toHaveBeenCalledOnce();
  });

  it('does not release when window has already started', async () => {
    const registry = makeRegistryClient({ releaseResult: true });
    const window = makeWindow({ windowStartTs: Date.now() - 1_000 }); // started 1s ago

    const released = await releaseClaimedNotStarted(window, registry);

    expect(released).toBe(false);
    expect(registry.releaseClaim).not.toHaveBeenCalled();
  });

  it('returns false when releaseClaim returns false (no active claim)', async () => {
    const registry = makeRegistryClient({ releaseResult: false });
    const window = makeWindow({ windowStartTs: Date.now() + 60_000 });

    const released = await releaseClaimedNotStarted(window, registry);

    expect(released).toBe(false);
  });
});
