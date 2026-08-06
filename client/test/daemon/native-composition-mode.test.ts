/**
 * Fleet composition-mode selection and its boot gate (one-swap M2, umbrella #2461).
 *
 * This is the flip switch Wave 3's deploy PR throws. Two properties are load-bearing:
 * default-legacy (so M2 changes nothing about today's boot) and native+mainnet = explicit refusal
 * (DR-2026-08-05 decision 8 — never a silent legacy fallback).
 */
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { resolveFleetCompositionMode } from '../../src/daemon/native-composition-mode.js';
import { NativeVerticalReadinessError } from '../../src/daemon/native-vertical-mode.js';

describe('resolveFleetCompositionMode', () => {
  it('defaults to legacy when the key is absent, on either network', () => {
    for (const configuredNetwork of ['testnet', 'mainnet'] as const) {
      expect(resolveFleetCompositionMode({ compositionMode: undefined, configuredNetwork }))
        .toBe('legacy');
    }
  });

  it('is legacy when explicitly legacy', () => {
    expect(resolveFleetCompositionMode({ compositionMode: 'legacy', configuredNetwork: 'testnet' }))
      .toBe('legacy');
  });

  it('selects native on testnet against the pinned deployment', () => {
    expect(resolveFleetCompositionMode({ compositionMode: 'native', configuredNetwork: 'testnet' }))
      .toBe('native');
  });

  // DR-2026-08-05 decision 8, and the coupling this test exists for: native + mainnet must be a
  // THROW, not a quiet 'legacy'. A future refactor that "helpfully" degrades to legacy here goes
  // red rather than shipping a fleet that silently ran the compatibility product on mainnet.
  it('REFUSES native on mainnet rather than falling back to legacy', () => {
    let thrown: unknown;
    try {
      resolveFleetCompositionMode({ compositionMode: 'native', configuredNetwork: 'mainnet' });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(NativeVerticalReadinessError);
    expect((thrown as NativeVerticalReadinessError).reason).toBe('network-mismatch');
  });

  it('REFUSES Base mainnet chainId 8453 outright, whatever the declared network', () => {
    const mainnetChain = { ...BASE_SEPOLIA_TODAY, chainId: 8453 };
    for (const configuredNetwork of ['testnet', 'mainnet'] as const) {
      let thrown: unknown;
      try {
        resolveFleetCompositionMode({
          compositionMode: 'native',
          configuredNetwork,
          chain: mainnetChain,
        });
      } catch (cause) {
        thrown = cause;
      }
      expect((thrown as NativeVerticalReadinessError).reason).toBe('mainnet-refused');
    }
  });

  it('REFUSES a testnet chain whose contracts are not the pinned deployment', () => {
    let thrown: unknown;
    try {
      resolveFleetCompositionMode({
        compositionMode: 'native',
        configuredNetwork: 'testnet',
        chain: { ...BASE_SEPOLIA_TODAY, taskCoordinator: `0x${'9'.repeat(40)}` },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect((thrown as NativeVerticalReadinessError).reason).toBe('contracts-mismatch');
  });
});
