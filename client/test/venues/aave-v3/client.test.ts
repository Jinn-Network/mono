import { describe, expect, it } from 'vitest';
import { liquidityRateRayToApyBps, scheduleSampleTimestamps } from '../../../src/venues/aave-v3/client.js';

describe('aave-v3 client helpers', () => {
  it('creates evenly spaced sample timestamps', () => {
    const out = scheduleSampleTimestamps(10_000_000, 3600, 12);
    expect(out).toHaveLength(12);
    expect(out[0]).toBe(6_400_000);
    expect(out[out.length - 1]).toBe(10_000_000);
  });

  it('converts a positive liquidity rate ray into APY bps', () => {
    const bps = liquidityRateRayToApyBps(50_000_000_000_000_000_000_000_000n); // 5e25
    expect(bps).toBeGreaterThan(0);
  });
});
