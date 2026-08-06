import { describe, expect, it } from 'vitest';
import {
  assertPostingFunds,
  postingBudgetWei,
} from '../../../src/native-requester/work-client/preflight/funds.js';
import { RequesterError } from '../../../src/native-requester/work-client/errors.js';

const base = {
  safeBalanceWei: 10_000n,
  agentBalanceWei: 20_000n,
  solutionMaxDeliveryRateWei: 500n,
  verdictMaxDeliveryRateWei: 500n,
  maxClaims: 2,
  agentGasReserveWei: 1_000n,
};

describe('assertPostingFunds', () => {
  it('computes the two-rail budget across claim slots', () => {
    expect(postingBudgetWei(base)).toBe(2_000n);
  });

  it('passes when both balances cover their requirement', () => {
    expect(() => assertPostingFunds(base)).not.toThrow();
  });

  it('names the Safe shortfall in the message', () => {
    try {
      assertPostingFunds({ ...base, safeBalanceWei: 1_999n });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequesterError);
      expect((err as RequesterError).code).toBe('safe-underfunded');
      expect((err as RequesterError).message).toContain('2000 wei');
      expect((err as RequesterError).message).toContain('1999 wei');
    }
  });

  it('requires the agent EOA to cover the budget plus the gas reserve', () => {
    try {
      assertPostingFunds({ ...base, agentBalanceWei: 2_999n });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).code).toBe('agent-underfunded');
      expect((err as RequesterError).category).toBe('funds');
    }
  });

  it('rejects a non-positive claim count as a config error', () => {
    try {
      assertPostingFunds({ ...base, maxClaims: 0 });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).category).toBe('config');
      expect((err as RequesterError).code).toBe('invalid-max-claims');
    }
  });
});
