import { describe, expect, it } from 'vitest';
import {
  POSTING_FRESHNESS_RESERVE_MS,
  RequestExpiredError,
  assertPostingFreshness,
} from '../../../src/native-requester/work-client/preflight/freshness.js';

const live = {
  claimWindowEndMs: 1_200_000,
  submissionDeadlineMs: 1_300_000,
  sessionDeadlineMs: 1_400_000,
};

describe('assertPostingFreshness', () => {
  it('uses a 60s execution reserve by default', () => {
    expect(POSTING_FRESHNESS_RESERVE_MS).toBe(60_000);
  });

  it('passes when every deadline stays live beyond the reserve', () => {
    expect(() => assertPostingFreshness(live, { nowMs: 1_000_000 })).not.toThrow();
  });

  it('names every expired deadline, in declaration order', () => {
    try {
      assertPostingFreshness(
        { ...live, claimWindowEndMs: Number.NaN, submissionDeadlineMs: 1_010_000 },
        { nowMs: 1_000_000 },
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequestExpiredError);
      expect((err as RequestExpiredError).expired).toEqual([
        'claim window end',
        'submission deadline',
      ]);
      expect((err as RequestExpiredError).category).toBe('freshness');
      expect((err as RequestExpiredError).code).toBe('request-expired');
    }
  });

  it('treats a deadline exactly at now plus reserve as expired', () => {
    expect(() =>
      assertPostingFreshness({ ...live, claimWindowEndMs: 1_060_000 }, { nowMs: 1_000_000 }),
    ).toThrow(RequestExpiredError);
  });

  it('honors an overridden reserve', () => {
    expect(() =>
      assertPostingFreshness({ ...live, claimWindowEndMs: 1_100_000 }, {
        nowMs: 1_000_000,
        reserveMs: 150_000,
      }),
    ).toThrow(RequestExpiredError);
  });
});
