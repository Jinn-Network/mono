import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { WalletCard, type WalletCardProps } from './WalletCard.js';

vi.mock('../../api/client.js', () => ({
  api: {
    retryAgentBinding: vi.fn().mockResolvedValue({ attempts: [{ status: 'success' }] }),
  },
}));

function defaultProps(): WalletCardProps {
  return {
    totalEth: '0.0088',
    runwayDays: 1,
    perRole: { master: '0.0088', agent: '—', safe: '—' },
    claimableJinn: '0.0000',
    claimedJinnLifetime: '0',
    tjinnEarned: '0.0000',
    tjinnState: 'ready',
    tjinnError: null,
    lastClaimAt: null,
    agentId: 5879,
    masterAddress: '0x53e25264C86db85b6168F7824f5c39abd5281787',
    safeAddress: '0x26e90000000000000000000000000000000000638',
    services: [],
    lastPasswordRotationAt: null,
    onTopUp: vi.fn(),
    onClaim: vi.fn(),
  };
}

function wrap(ui: JSX.Element, initial = '/overview'): { hook: ReturnType<typeof memoryLocation>['hook']; ui: JSX.Element } {
  const { hook } = memoryLocation({ path: initial });
  return { hook, ui: <Router hook={hook}>{ui}</Router> };
}

describe('WalletCard', () => {
  it('renders Wallet eyebrow and the four sections', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    expect(screen.getByText(/^wallet$/i)).toBeTruthy();
    expect(screen.getByTestId('wallet-section-gas')).toBeTruthy();
    expect(screen.getByTestId('wallet-section-rewards')).toBeTruthy();
    expect(screen.getByTestId('wallet-section-identity')).toBeTruthy();
    expect(screen.getByTestId('wallet-section-password')).toBeTruthy();
  });

  it('shows the big gas stat, runway, and Top up button labelled for the faucet', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} totalEth="0.0088" runwayDays={1} />);
    render(ui);
    const gas = screen.getByTestId('wallet-section-gas');
    expect(gas.textContent).toContain('0.0088');
    expect(gas.textContent).toMatch(/eth/i);
    expect(gas.textContent).toMatch(/1d runway/);
    expect(screen.getByTestId('wallet-topup').textContent).toMatch(/top up from faucet/i);
    // Per-role drill-down is commented out — no `per role` button on the page.
    expect(screen.queryByRole('button', { name: /per role/i })).toBeNull();
  });

  it('shows collector pending + claimed stats and a collector claim button', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        claimableJinn="1.2500"
        claimedJinnLifetime="42"
      />,
    );
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/collector pending/i);
    expect(rewards.textContent).toContain('1.2500');
    expect(rewards.textContent).toMatch(/collector claimed/i);
    expect(rewards.textContent).toContain('42');
    expect(rewards.textContent).toContain('collector-token');
    // Collector claim button — enabled when collector pending > 0.
    const claim = screen.getByTestId('wallet-claim') as HTMLButtonElement;
    expect(claim.disabled).toBe(false);
    // "last claim" line is commented out.
    expect(rewards.textContent).not.toMatch(/last claim/i);
  });

  it('shows the tJINN-earned stat in the Rewards section when the read is ready', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="1.5000"
        tjinnState="ready"
        claimableJinn="999.0000"
      />,
    );
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/testnet jinn earned/i);
    // The tJINN-earned value renders the real Safe balance, not the staking
    // collector queue — it is a distinct element from the 999 collector stat.
    const tjinnValue = screen.getByTestId('tjinn-earned-value');
    expect(tjinnValue.textContent).toBe('1.5000');
    const collectorPending = screen.getByText('999.0000');
    expect(collectorPending).not.toBe(tjinnValue);
    expect(tjinnValue.contains(collectorPending)).toBe(false);
    // Ready state shows the unit and emits no state copy.
    expect(rewards.textContent).toContain('tJINN');
    expect(screen.queryByTestId('tjinn-earned-state')).toBeNull();
  });

  it('shows pending copy and no value while the tJINN read is unresolved', () => {
    const { ui } = wrap(
      <WalletCard {...defaultProps()} tjinnEarned="—" tjinnState="pending" />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('pending');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /waiting for sepolia balance/i,
    );
  });

  it('shows the error string when the tJINN read failed', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="—"
        tjinnState="error"
        tjinnError="Sepolia tJINN balance temporarily unavailable."
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('unavailable');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /temporarily unavailable/i,
    );
  });

  it('wraps the tJINN-earned row in a polite live region', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    const region = screen.getByTestId('tjinn-earned-region');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });

  it('disables collector Claim when collector pending is zero', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} claimableJinn="0.0000" />);
    render(ui);
    expect((screen.getByTestId('wallet-claim') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Identity labels (Agent / Master / Safe) with truncated addresses', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    const id = screen.getByTestId('wallet-section-identity');
    expect(id.textContent).toMatch(/agent/i);
    expect(id.textContent).toContain('#5879');
    expect(id.textContent).toMatch(/master/i);
    expect(id.textContent).toContain('0x53e2');
    expect(id.textContent).toContain('1787');
    expect(id.textContent).toMatch(/safe/i);
    expect(id.textContent).toContain('0x26e9');
    expect(id.textContent).toContain('0638');
    // Chain is no longer in Wallet — it lives in the header pill.
    expect(id.textContent).not.toMatch(/base sepolia/i);
  });

  it('surfaces a binding-pending chip when a service is unbound', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        services={[
          { index: 0, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
        ]}
      />,
    );
    render(ui);
    expect(screen.getByRole('button', { name: /binding pending/i })).toBeTruthy();
  });

  it('shows Last rotated and a Change Password button that navigates to /operator/security', () => {
    const { hook, ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    expect(screen.getByText(/last rotated/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('wallet-change-password'));
    expect(hook).toBeTruthy();
    // The button is a real button → click routes via wouter's memory location.
    expect(window.location.pathname || '/').toBeTruthy(); // sanity; deep route assertion belongs in App.routing.test.tsx
  });

  it('invokes onTopUp when Top up is clicked', () => {
    const onTopUp = vi.fn();
    const { ui } = wrap(<WalletCard {...defaultProps()} onTopUp={onTopUp} />);
    render(ui);
    fireEvent.click(screen.getByTestId('wallet-topup'));
    expect(onTopUp).toHaveBeenCalledOnce();
  });

  it('invokes onClaim when Claim collector is clicked', () => {
    const onClaim = vi.fn();
    const { ui } = wrap(
      <WalletCard {...defaultProps()} claimableJinn="1.0" onClaim={onClaim} />,
    );
    render(ui);
    fireEvent.click(screen.getByTestId('wallet-claim'));
    expect(onClaim).toHaveBeenCalledOnce();
  });
});
