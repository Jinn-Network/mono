/**
 * An unconfigured escrow cap is PERMISSIVE, not zero (one-swap M2 review, umbrella #2461).
 *
 * `composition-root.ts`'s `buildOperatorCaps` states the repo's convention for the legacy path —
 * the F7-REVERSED no-claim-nothing ruling: "an unconfigured cap is permissive, not zero, because
 * the host's USD rolling-window gates remain the operative spend bound." `'0'` is a distinct,
 * deliberate claim-nothing state the operator app renders as such.
 *
 * Getting this backwards on the native path is not a cosmetic bug: `evaluateNativeClaim` refuses a
 * zero `maxSpendWei` with reason `spend-policy`, so an operator who never set a cap would see every
 * card permanently refused for the wrong reason — masking the `finality-policy` signal M3's
 * discovery decode is supposed to surface.
 */
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { buildOperatorCaps } from '../../src/daemon/composition-root.js';
import { buildNativeClaimPolicy } from '../../src/daemon/native-assembly.js';
import { resolveFleetEscrowMaxWei } from '../../src/daemon/native-fleet-runtime.js';

const CHAIN = {
  chainId: BASE_SEPOLIA_TODAY.chainId,
  generation: BASE_SEPOLIA_TODAY.generation,
  contracts: {
    taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
    mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
    activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
  },
};

function nativeMaxSpendWei(claimPolicy: Parameters<typeof resolveFleetEscrowMaxWei>[0]): bigint {
  return buildNativeClaimPolicy({
    ...CHAIN,
    transactionCaps: { escrowMaxWei: resolveFleetEscrowMaxWei(claimPolicy) },
  }).maxSpendWei;
}

describe('fleet native escrow cap', () => {
  it('does NOT produce maxSpendWei 0n when claimPolicy is absent', () => {
    expect(nativeMaxSpendWei(undefined)).not.toBe(0n);
  });

  it('does NOT produce maxSpendWei 0n when claimPolicy omits spendCapWei', () => {
    expect(nativeMaxSpendWei({ mode: 'every-runnable' })).not.toBe(0n);
  });

  it('uses the SAME permissive bound the legacy path uses for an unconfigured cap', () => {
    // Pinned against `buildOperatorCaps` itself, not a copied literal: if the legacy convention
    // ever moves, this goes red rather than the two paths silently diverging.
    const legacy = buildOperatorCaps(undefined).spendCapWei;
    expect(nativeMaxSpendWei(undefined)).toBe(legacy);
    expect(nativeMaxSpendWei({ mode: 'every-runnable' })).toBe(legacy);
  });

  it('still treats a CONFIGURED "0" as claim-nothing', () => {
    expect(nativeMaxSpendWei({ mode: 'every-runnable', spendCapWei: '0' })).toBe(0n);
    // ... and matches the legacy path's reading of the same configured value.
    expect(buildOperatorCaps({ mode: 'every-runnable', spendCapWei: '0' }).spendCapWei).toBe(0n);
  });

  it('passes an ordinary configured cap through unchanged', () => {
    expect(nativeMaxSpendWei({ mode: 'every-runnable', spendCapWei: '1250000000000000' }))
      .toBe(1_250_000_000_000_000n);
  });

  it('returns a canonical decimal wei string, never a number or bigint', () => {
    for (const policy of [undefined, { mode: 'every-runnable' as const, spendCapWei: '0' }]) {
      const value = resolveFleetEscrowMaxWei(policy);
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+$/u);
    }
  });
});
