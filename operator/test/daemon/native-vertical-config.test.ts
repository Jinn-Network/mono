import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { describe, expect, it } from 'vitest';

import { resolveConfiguredOperatorVerticalMode } from '../../src/daemon/native-vertical-config.js';

const nativeBlock = {
  chainId: 84532 as const,
  generation: 'today' as const,
  contracts: {
    taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
    mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
    activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
  },
  liveClosureReceiptPath: '/missing-live-closure.json',
};

describe('resolveConfiguredOperatorVerticalMode (D5 fleet entry)', () => {
  it('reports fleet-legacy when verticalMode is absent, even if operator.native is present', () => {
    expect(resolveConfiguredOperatorVerticalMode({
      network: 'testnet',
      operator: { native: nativeBlock },
    })).toEqual({
      requestedMode: undefined,
      effectiveMode: 'legacy',
      readiness: 'live-closure-missing',
    });
  });

  it('does not run the native boot gate for absent verticalMode on mainnet', () => {
    expect(resolveConfiguredOperatorVerticalMode({
      network: 'mainnet',
    })).toEqual({
      requestedMode: undefined,
      effectiveMode: 'legacy',
      readiness: 'live-closure-missing',
    });
  });

  it('keeps explicit legacy off the native boot gate', () => {
    expect(resolveConfiguredOperatorVerticalMode({
      network: 'testnet',
      operator: { verticalMode: 'legacy' },
    })).toEqual({
      requestedMode: 'legacy',
      effectiveMode: 'legacy',
      readiness: 'explicit-legacy',
    });
  });

  it('still refuses leftover explicit native-v1 without operator.native', () => {
    expect(() => resolveConfiguredOperatorVerticalMode({
      network: 'testnet',
      operator: { verticalMode: 'native-v1' },
    })).toThrow(/native-v1 requires operator.native configuration/u);
  });

  it('still takes the native boot gate for leftover explicit native-v1', () => {
    expect(resolveConfiguredOperatorVerticalMode({
      network: 'testnet',
      operator: { verticalMode: 'native-v1', native: nativeBlock },
    })).toEqual({
      requestedMode: 'native-v1',
      effectiveMode: 'native-v1',
      readiness: 'explicit-native-unvalidated',
    });
  });
});
