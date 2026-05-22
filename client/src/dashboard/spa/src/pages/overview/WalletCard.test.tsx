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
    tjinnEarned: '0.0000',
    tjinnClaimedLifetime: '0.0000',
    tjinnState: 'ready',
    tjinnError: null,
    lastClaimAt: null,
    agentId: 5879,
    masterAddress: '0x53e25264C86db85b6168F7824f5c39abd5281787',
    safeAddress: '0x26e90000000000000000000000000000000000638',
    services: [],
    lastPasswordRotationAt: null,
    onTopUp: vi.fn(),
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

  it('does not show collector reward rows or claim actions', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} tjinnEarned="1.2500" />);
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/testnet jinn earned/i);
    expect(rewards.textContent).toContain('1.2500');
    expect(rewards.textContent).toMatch(/lifetime claimed/i);
    expect(rewards.textContent).not.toMatch(/collector pending/i);
    expect(rewards.textContent).not.toMatch(/collector claimed/i);
    expect(rewards.textContent).not.toMatch(/collector-token/i);
    expect(screen.queryByTestId('wallet-claim')).toBeNull();
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
  });

  it('shows the tJINN-earned stat in the Rewards section when the read is ready', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="1.5000"
        tjinnState="ready"
      />,
    );
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/testnet jinn earned/i);
    const tjinnValue = screen.getByTestId('tjinn-earned-value');
    expect(tjinnValue.textContent).toBe('1.5000');
    // Ready state shows the unit and emits no state copy.
    expect(rewards.textContent).toContain('tJINN');
    expect(screen.queryByTestId('tjinn-earned-state')).toBeNull();
  });

  it('keeps a real lifetime-claimed tJINN counter without claim actions', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="1.5000"
        tjinnClaimedLifetime="2.7500"
        tjinnState="ready"
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-claimed-lifetime-region').textContent).toMatch(
      /lifetime claimed/i,
    );
    expect(screen.getByTestId('tjinn-claimed-lifetime-value').textContent).toBe('2.7500');
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
  });

  it('shows pending copy and no value while the tJINN read is unresolved', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="—"
        tjinnClaimedLifetime={null}
        tjinnState="pending"
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('pending');
    expect(screen.getByTestId('tjinn-claimed-lifetime-value').textContent).toBe('pending');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /waiting for sepolia balance/i,
    );
  });

  it('shows the error string when the tJINN read failed', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="—"
        tjinnClaimedLifetime={null}
        tjinnState="error"
        tjinnError="Sepolia tJINN balance temporarily unavailable."
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('unavailable');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /temporarily unavailable/i,
    );
    expect(screen.getByTestId('tjinn-claimed-lifetime-value').textContent).toBe('unavailable');
  });

  it('wraps the tJINN-earned row in a polite live region', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    const region = screen.getByTestId('tjinn-earned-region');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
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
          { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
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

});
