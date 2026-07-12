import { describe, it, expect } from 'vitest';
import { DEFAULT_MASTER_ETH_DAILY_WEI } from '../../src/earning/master-gas.js';
import { resolveMasterDailyEstimateWei } from '../../src/api/status-build.js';

describe('DEFAULT_MASTER_ETH_DAILY_WEI single source of truth', () => {
  it('status-side resolver reads the shared constant', () => {
    expect(resolveMasterDailyEstimateWei(undefined, 5000)).toBe(
      DEFAULT_MASTER_ETH_DAILY_WEI,
    );
  });

  it('pins the exact conservative default (~0.0005 ETH/day)', () => {
    expect(DEFAULT_MASTER_ETH_DAILY_WEI).toBe(500_000_000_000_000n);
  });
});
