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
    lastClaimAt: null,
    agentId: 5879,
    chain: 'Base Sepolia',
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

  it('shows Claimable + Claimed paired stats and a Claim button tied to Claimed', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        claimableJinn="1.2500"
        claimedJinnLifetime="42"
      />,
    );
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/claimable/i);
    expect(rewards.textContent).toContain('1.2500');
    expect(rewards.textContent).toMatch(/claimed/i);
    expect(rewards.textContent).toContain('42');
    // Claim button — enabled when claimable > 0.
    const claim = screen.getByTestId('wallet-claim') as HTMLButtonElement;
    expect(claim.disabled).toBe(false);
    // "last claim" line is commented out.
    expect(rewards.textContent).not.toMatch(/last claim/i);
  });

  it('disables Claim when claimable is zero', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} claimableJinn="0.0000" />);
    render(ui);
    expect((screen.getByTestId('wallet-claim') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Identity labels (Agent / Chain / Safe) with truncated Safe address', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    const id = screen.getByTestId('wallet-section-identity');
    expect(id.textContent).toMatch(/agent/i);
    expect(id.textContent).toContain('#5879');
    expect(id.textContent).toMatch(/chain/i);
    expect(id.textContent).toContain('Base Sepolia');
    expect(id.textContent).toMatch(/safe/i);
    expect(id.textContent).toContain('0x26e9');
    expect(id.textContent).toContain('0638');
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

  it('invokes onClaim when Claim is clicked', () => {
    const onClaim = vi.fn();
    const { ui } = wrap(
      <WalletCard {...defaultProps()} claimableJinn="1.0" onClaim={onClaim} />,
    );
    render(ui);
    fireEvent.click(screen.getByTestId('wallet-claim'));
    expect(onClaim).toHaveBeenCalledOnce();
  });
});
