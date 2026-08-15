import { describe, it, expect } from 'vitest';
import {
  computeEscrowWei,
  resolveMintedTaskDeliveryRate,
  type EscrowParams,
} from '../../src/solver-types/_swe-rebench-v2-escrow.js';
import { DEFAULT_SYNTHETIC_ESCROW_PARAMS } from '../../src/solver-types/_swe-rebench-v2-harvest.js';

const params: EscrowParams = {
  base_escrow_wei: 1_000_000_000_000_000_000n,
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
  loc_normalizer: 100,
  files_normalizer: 5,
  tests_normalizer: 10,
};

describe('computeEscrowWei', () => {
  it('returns base for trivial tasks (1 LoC, 1 file, 1 test)', () => {
    const escrow = computeEscrowWei({ loc: 1, files: 1, tests: 1, params });
    // multiplier = 1 + 0.5*0.01 + 0.3*0.2 + 0.2*0.1 = 1.085
    expect(escrow).toBe(1_085_000_000_000_000_000n);
  });

  it('scales up linearly with complexity proxies', () => {
    const small = computeEscrowWei({ loc: 10, files: 1, tests: 1, params });
    const large = computeEscrowWei({ loc: 100, files: 5, tests: 10, params });
    expect(large).toBeGreaterThan(small);
  });

  it('caps the multiplier so single-task escrow does not blow up', () => {
    const huge = computeEscrowWei({ loc: 10000, files: 100, tests: 1000, params });
    expect(huge).toBeLessThanOrEqual(5n * params.base_escrow_wei);
  });
});

describe('resolveMintedTaskDeliveryRate', () => {
  const base = 1_000_000_000_000_000_000n;

  it('returns flat rate for benchmark tasks', () => {
    expect(resolveMintedTaskDeliveryRate(base, undefined)).toBe(base);
  });

  it('returns complexity-weighted rate for minted tasks with inputs', () => {
    const rate = resolveMintedTaskDeliveryRate(base, {
      syntheticEscrow: true,
      syntheticEscrowInputs: { loc: 100, files: 5, tests: 10 },
      syntheticEscrowParams: DEFAULT_SYNTHETIC_ESCROW_PARAMS,
    });
    expect(rate).toBeGreaterThan(base);
  });
});
