import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the funding card. Covers the first-run BYO-RPC nudge
 * (jinn-mono #325) and the faucet drip progress + timeout behavior
 * (issue #979).
 *
 * Controllable drip mock: tests set `dripImpl` to resolve, reject, or hang.
 */
let dripImpl: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
const triggerDrip = vi.fn((opts?: { signal?: AbortSignal }) => dripImpl(opts));

vi.mock('../api/client.js', () => ({
  api: {
    triggerDrip: (opts?: { signal?: AbortSignal }) => triggerDrip(opts),
  },
}));

const { AwaitingFundingCard } = await import('./AwaitingFundingCard.js');

const BASE_PROPS = {
  address: '0x1111111111111111111111111111111111111111',
  minimumWei: '10000000000000000',
  chainExplorerBase: 'https://sepolia.basescan.org',
};

beforeEach(() => {
  triggerDrip.mockClear();
  // Default: a drip that resolves with a not-used reason. Individual tests
  // that exercise pending/timeout behavior override this.
  dripImpl = async () => ({ ok: false, reason: 'not used in this test' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AwaitingFundingCard — shared-RPC nudge', () => {
  it('shows the BYO-RPC nudge when on the shared default RPC', () => {
    render(<AwaitingFundingCard {...BASE_PROPS} onSharedDefaultRpc />);
    const nudge = screen.getByTestId('onboarding-shared-rpc-nudge');
    expect(nudge.textContent).toMatch(/shared trial rpc/i);
    expect(nudge.textContent).toMatch(/add your own key/i);
  });

  it('omits the nudge when a custom RPC is configured', () => {
    render(<AwaitingFundingCard {...BASE_PROPS} onSharedDefaultRpc={false} />);
    expect(screen.queryByTestId('onboarding-shared-rpc-nudge')).toBeNull();
  });

  it('omits the nudge by default (prop unset)', () => {
    render(<AwaitingFundingCard {...BASE_PROPS} />);
    expect(screen.queryByTestId('onboarding-shared-rpc-nudge')).toBeNull();
  });
});

describe('AwaitingFundingCard — drip deadline (issue #979)', () => {
  it('surfaces a timeout status with a retry button after the deadline elapses', async () => {
    vi.useFakeTimers();
    // A drip request that aborts when its signal fires (mirrors fetch abort).
    dripImpl = (opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });

    render(<AwaitingFundingCard {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));

    // Before the deadline: still in the pending/requesting state.
    expect(screen.getByRole('button', { name: /funding/i })).toBeTruthy();
    expect(screen.queryByTestId('drip-timed-out')).toBeNull();

    // Advance past the 5.5-minute client deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5.5 * 60 * 1000 + 100);
    });

    const timeout = screen.getByTestId('drip-timed-out');
    expect(timeout.textContent).toMatch(/still arriving/i);
    // Retry affordance is present and the faucet button is clickable again.
    expect(
      screen.getAllByRole('button', { name: /try again|retry|fund from faucet/i }).length,
    ).toBeGreaterThan(0);
  });
});

describe('AwaitingFundingCard — real balance progress (issue #979)', () => {
  it('drives the progress bar from currentBalanceWei vs target, not a time curve', () => {
    vi.useFakeTimers();
    render(
      <AwaitingFundingCard
        {...BASE_PROPS}
        minimumWei="10000000000000000"
        currentBalanceWei="5000000000000000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));

    // Balance is 50% of target → progressbar value ~50 immediately, with the
    // fake clock NOT advanced (proves it is balance-driven, not elapsed-time).
    const bar = screen.getByTestId('drip-progress');
    const value = Number(bar.getAttribute('data-value') ?? bar.getAttribute('aria-valuenow'));
    expect(value).toBeGreaterThanOrEqual(45);
    expect(value).toBeLessThanOrEqual(55);
  });

  it('shows balance-vs-target text while requesting', () => {
    render(
      <AwaitingFundingCard
        {...BASE_PROPS}
        minimumWei="10000000000000000"
        currentBalanceWei="5000000000000000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    expect(screen.getByText(/balance .* \/ target/i)).toBeTruthy();
  });
});

describe('AwaitingFundingCard — honest expected-wait copy (issue #979)', () => {
  it('does not promise "about a minute" and sets expectation of several minutes', () => {
    render(<AwaitingFundingCard {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    // The old misleading copy is gone.
    expect(screen.queryByText(/about a minute/i)).toBeNull();
    // Honest rate-limited expectation is present.
    expect(screen.getByText(/rate-limited|a few minutes/i)).toBeTruthy();
  });
});
