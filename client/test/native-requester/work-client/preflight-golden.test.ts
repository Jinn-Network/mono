import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRequesterError } from '../../../src/native-requester/work-client/errors.js';
import {
  POSTING_FRESHNESS_RESERVE_MS,
  POSTING_PREFLIGHT_CATEGORIES,
  assertPostingFreshness,
  assertPostingFunds,
  selectLiveTarget,
} from '../../../src/native-requester/work-client/preflight/index.js';

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/preflight-behavior.golden.json', import.meta.url)),
    'utf-8',
  ),
);

function capture(run: () => void): { category?: string; code?: string; expired?: string[] } {
  try {
    run();
    return {};
  } catch (err) {
    if (!isRequesterError(err)) throw err;
    const expired = (err as unknown as { expired?: string[] }).expired;
    return { category: err.category, code: err.code, ...(expired ? { expired } : {}) };
  }
}

describe('preflight golden behavior', () => {
  it('pins the reserve and the category order', () => {
    expect(POSTING_FRESHNESS_RESERVE_MS).toBe(golden.freshnessReserveMs);
    expect(POSTING_PREFLIGHT_CATEGORIES).toEqual(golden.categoryOrder);
  });

  for (const testCase of golden.funds) {
    it(`funds: ${testCase.name}`, () => {
      const input = testCase.input;
      const actual = capture(() =>
        assertPostingFunds({
          safeBalanceWei: BigInt(input.safeBalanceWei),
          agentBalanceWei: BigInt(input.agentBalanceWei),
          solutionMaxDeliveryRateWei: BigInt(input.solutionMaxDeliveryRateWei),
          verdictMaxDeliveryRateWei: BigInt(input.verdictMaxDeliveryRateWei),
          maxClaims: input.maxClaims,
          agentGasReserveWei: BigInt(input.agentGasReserveWei),
        }),
      );
      expect(actual).toEqual(testCase.expect.ok ? {} : testCase.expect.error);
    });
  }

  for (const testCase of golden.freshness) {
    it(`freshness: ${testCase.name}`, () => {
      const input = testCase.input;
      const actual = capture(() =>
        assertPostingFreshness(
          {
            claimWindowEndMs: input.claimWindowEndMs ?? Number.NaN,
            submissionDeadlineMs: input.submissionDeadlineMs ?? Number.NaN,
            sessionDeadlineMs: input.sessionDeadlineMs ?? Number.NaN,
          },
          { nowMs: input.nowMs },
        ),
      );
      expect(actual).toEqual(testCase.expect.ok ? {} : testCase.expect.error);
    });
  }

  for (const testCase of golden.target) {
    it(`target: ${testCase.name}`, () => {
      const input = testCase.input;
      if (testCase.expect.ok) {
        expect(selectLiveTarget(input).postingKey).toBe(testCase.expect.postingKey);
        return;
      }
      expect(capture(() => selectLiveTarget(input))).toEqual(testCase.expect.error);
    });
  }
});
