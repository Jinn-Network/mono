import { describe, it, expect } from 'vitest';
import {
  projectRunwayTasks,
  CLAIM_TX_GAS,
  CLAIM_GAS_PRICE_WEI,
  LOW_RUNWAY_TASKS,
} from './helpers.js';

describe('projectRunwayTasks', () => {
  it('exposes claim-gas + low-runway constants', () => {
    expect(CLAIM_TX_GAS).toBe(175000n);
    expect(CLAIM_GAS_PRICE_WEI).toBe(11_500_000n);
    expect(LOW_RUNWAY_TASKS).toBe(100);
  });

  it('returns null when any input is missing or non-numeric', () => {
    expect(projectRunwayTasks(undefined, '100', '50')).toBeNull();
    expect(projectRunwayTasks('1500', undefined, '50')).toBeNull();
    expect(projectRunwayTasks('1500', '100', undefined)).toBeNull();
    expect(projectRunwayTasks('1.5', '100', '50')).toBeNull();
    expect(projectRunwayTasks('abc', '100', '50')).toBeNull();
  });

  it('folds the claim-tx gas term into per-Task cost', () => {
    // solution 1000 gwei + verdict 500 gwei + claim gas 2012.5 gwei
    const result = projectRunwayTasks(
      '14050000000000', // balance = 4 × per-Task cost
      '1000000000000', // 1000 gwei
      '500000000000', // 500 gwei
    );
    expect(result).not.toBeNull();
    // 1000000000000 + 500000000000 + (175000 * 11_500_000) = 3_512_500_000_000
    expect(result!.perTaskWei).toBe(3_512_500_000_000n);
    expect(result!.tasks).toBe(4);
  });

  it('no longer returns the wildly optimistic 133,333 from the issue', () => {
    // The exact regression: 0.002 ETH safe balance, 15 gwei manifest per-Task.
    const result = projectRunwayTasks(
      '2000000000000000', // 0.002 ETH
      '10000000000', // 10 gwei
      '5000000000', // 5 gwei
    );
    expect(result).not.toBeNull();
    expect(result!.tasks).not.toBe(133333);
    expect(result!.tasks).toBe(986); // gas-inclusive reality, ~1,000
  });

  it('accepts an explicit claimGasWei override', () => {
    const result = projectRunwayTasks('300', '100', '50', 0n);
    // With zero claim gas, per-Task = 150, 300 / 150 = 2.
    expect(result!.perTaskWei).toBe(150n);
    expect(result!.tasks).toBe(2);
  });

  it('flags lowRunway true below the threshold, false at/above it', () => {
    // per-Task cost = 3_512_500_000_000.
    const below = projectRunwayTasks(
      '347737500000000', // 99 × per-Task
      '1000000000000',
      '500000000000',
    );
    expect(below!.tasks).toBe(99);
    expect(below!.lowRunway).toBe(true);

    const at = projectRunwayTasks(
      '351250000000000', // 100 × per-Task
      '1000000000000',
      '500000000000',
    );
    expect(at!.tasks).toBe(100);
    expect(at!.lowRunway).toBe(false);
  });
});
