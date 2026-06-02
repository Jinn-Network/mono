import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleReStakeReceipt } from '../../src/earning/bootstrap.js';

describe('handleReStakeReceipt (#916)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spyOnError = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  const loggedFrom = (spy: ReturnType<typeof spyOnError>) =>
    spy.mock.calls.map((c) => c.join(' ')).join('\n');

  it.each([
    { revertReason: 'InsufficientBalance', expectedReason: 'reason: InsufficientBalance' },
    { revertReason: undefined, expectedReason: 'reason: unavailable' },
  ])('throws and logs "reStake reverted" with $expectedReason', ({ revertReason, expectedReason }) => {
    const errorSpy = spyOnError();

    expect(() =>
      handleReStakeReceipt({
        receipt: { status: 'reverted' } as any,
        serviceDisplayIndex: 1,
        reStakeHash: '0xabc' as any,
        revertReason,
      }),
    ).toThrow(/reStake reverted/);

    const logged = loggedFrom(errorSpy);
    expect(logged).toMatch(/reStake reverted/);
    expect(logged).toMatch(new RegExp(expectedReason));
    expect(logged).not.toMatch(/reStake confirmed/);
  });

  it('logs "reStake confirmed" and does not throw on a successful receipt', () => {
    const errorSpy = spyOnError();

    expect(() =>
      handleReStakeReceipt({
        receipt: { status: 'success' } as any,
        serviceDisplayIndex: 1,
        reStakeHash: '0xabc' as any,
        revertReason: undefined,
      }),
    ).not.toThrow();

    const logged = loggedFrom(errorSpy);
    expect(logged).toMatch(/reStake confirmed/);
    expect(logged).not.toMatch(/reStake reverted/);
  });
});
