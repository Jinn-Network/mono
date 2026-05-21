import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for the first-run BYO-RPC nudge on the funding card (jinn-mono #325).
 *
 * The card itself talks to `api.triggerDrip`; we only exercise the static
 * shared-RPC affordance here, so the api module is stubbed to a no-op.
 */

vi.mock('../api/client.js', () => ({
  api: {
    triggerDrip: async () => ({ ok: false, reason: 'not used in this test' }),
  },
}));

const { AwaitingFundingCard } = await import('./AwaitingFundingCard.js');

const BASE_PROPS = {
  address: '0x1111111111111111111111111111111111111111',
  minimumWei: '10000000000000000',
  chainExplorerBase: 'https://sepolia.basescan.org',
};

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
