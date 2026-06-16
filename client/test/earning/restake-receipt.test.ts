import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleReStakeReceipt } from '../../src/earning/bootstrap.js';

describe('handleReStakeReceipt (#916, #1060)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spy = (method: 'error' | 'debug' | 'log') =>
    vi.spyOn(console, method).mockImplementation(() => {});
  const loggedFrom = (s: ReturnType<typeof spy>) =>
    s.mock.calls.map((c) => c.join(' ')).join('\n');

  it.each([
    { revertReason: 'InsufficientBalance', expectedReason: 'reason: InsufficientBalance' },
    { revertReason: undefined, expectedReason: 'reason: unavailable' },
  ])(
    'throws and logs "reStake reverted" with $expectedReason at debug level, not error (#1060)',
    ({ revertReason, expectedReason }) => {
      const errorSpy = spy('error');
      const debugSpy = spy('debug');

      // Control flow is unchanged (#916): a reverted reStake still throws so the
      // recovery attempt re-queues.
      expect(() =>
        handleReStakeReceipt({
          receipt: { status: 'reverted' } as any,
          serviceDisplayIndex: 1,
          reStakeHash: '0xabc' as any,
          revertReason,
        }),
      ).toThrow(/reStake reverted/);

      const debugLogged = loggedFrom(debugSpy);
      expect(debugLogged).toMatch(/reStake reverted/);
      expect(debugLogged).toMatch(new RegExp(expectedReason));
      expect(debugLogged).not.toMatch(/reStake confirmed/);
      // OLAS staking is non-load-bearing substrate — a benign reStake revert
      // (NotEnoughTimeStaked window / stale-RPC race) must not read as an error
      // (#1060 / DR-2026-06-04).
      expect(loggedFrom(errorSpy)).not.toMatch(/reStake reverted/);
    },
  );

  it('logs "reStake confirmed" at log level, never error, and does not throw on success (#1060)', () => {
    const errorSpy = spy('error');
    const logSpy = spy('log');

    expect(() =>
      handleReStakeReceipt({
        receipt: { status: 'success' } as any,
        serviceDisplayIndex: 1,
        reStakeHash: '0xabc' as any,
        revertReason: undefined,
      }),
    ).not.toThrow();

    const logLogged = loggedFrom(logSpy);
    expect(logLogged).toMatch(/reStake confirmed/);
    expect(logLogged).not.toMatch(/reStake reverted/);
    // reStake SUCCESS must never be logged at error level — the wrong-severity
    // bug this fix removes (#1060).
    expect(loggedFrom(errorSpy)).not.toMatch(/reStake confirmed/);
  });
});
