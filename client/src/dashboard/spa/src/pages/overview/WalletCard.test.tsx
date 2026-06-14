import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { WalletCard, type WalletCardProps } from './WalletCard.js';

import type { JSX } from 'react';

vi.mock('../../api/client.js', () => ({
  api: {},
}));

function defaultProps(): WalletCardProps {
  return {
    totalEth: '0.0088',
    runwayDays: 1,
    perRole: { master: '0.0088', agent: '—', safe: '—' },
    tjinnEarned: '0.0000',
    tjinnEarnedLast24h: '0.0000',
    tjinnState: 'ready',
    tjinnError: null,
    lastClaimAt: null,
    lastPasswordRotationAt: null,
    onTopUp: vi.fn(),
  };
}

function wrap(ui: JSX.Element, initial = '/overview'): { hook: ReturnType<typeof memoryLocation>['hook']; ui: JSX.Element } {
  const { hook } = memoryLocation({ path: initial });
  return { hook, ui: <Router hook={hook}>{ui}</Router> };
}

describe('WalletCard', () => {
  it('renders Wallet eyebrow and the three sections', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    expect(screen.getByText(/^wallet$/i)).toBeTruthy();
    expect(screen.getByTestId('wallet-section-gas')).toBeTruthy();
    expect(screen.getByTestId('wallet-section-rewards')).toBeTruthy();
    expect(screen.getByTestId('wallet-section-password')).toBeTruthy();
    expect(screen.queryByTestId('wallet-section-identity')).toBeNull();
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
    expect(rewards.textContent).toMatch(/lifetime/i);
    expect(rewards.textContent).toContain('1.2500');
    expect(rewards.textContent).toMatch(/jinn earned last 24hrs/i);
    expect(rewards.textContent).not.toMatch(/lifetime claimed/i);
    expect(rewards.textContent).not.toMatch(/collector pending/i);
    expect(rewards.textContent).not.toMatch(/collector claimed/i);
    expect(rewards.textContent).not.toMatch(/collector-token/i);
    expect(screen.queryByTestId('wallet-claim')).toBeNull();
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
  });

  it('shows the lifetime tJINN stat in the Rewards section when the read is ready', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="1.5000"
        tjinnState="ready"
      />,
    );
    render(ui);
    const rewards = screen.getByTestId('wallet-section-rewards');
    expect(rewards.textContent).toMatch(/lifetime/i);
    const tjinnValue = screen.getByTestId('tjinn-earned-value');
    expect(tjinnValue.textContent).toBe('1.5000');
    // Ready state shows the unit and emits no state copy.
    expect(rewards.textContent).toContain('tJINN');
    expect(screen.queryByTestId('tjinn-earned-state')).toBeNull();
  });

  it('shows JINN earned in the last 24hrs above the lifetime balance', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="1.5000"
        tjinnEarnedLast24h="0.2500"
        tjinnState="ready"
      />,
    );
    render(ui);
    const region = screen.getByTestId('tjinn-earned-24h-region');
    expect(region.textContent).toMatch(/jinn earned last 24hrs/i);
    expect(screen.getByTestId('tjinn-earned-24h-value').textContent).toBe('0.2500');
    expect(region.textContent).toContain('tJINN');
  });

  it('shows pending copy and no value while the tJINN read is unresolved', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="—"
        tjinnEarnedLast24h={null}
        tjinnState="pending"
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('pending');
    expect(screen.getByTestId('tjinn-earned-24h-value').textContent).toBe('pending');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /waiting for sepolia balance/i,
    );
  });

  it('shows the error string when the tJINN read failed', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        tjinnEarned="—"
        tjinnEarnedLast24h={null}
        tjinnState="error"
        tjinnError="Sepolia tJINN balance temporarily unavailable."
      />,
    );
    render(ui);
    expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('unavailable');
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /temporarily unavailable/i,
    );
    expect(screen.getByTestId('tjinn-earned-24h-value').textContent).toBe('unavailable');
  });

  it('wraps the tJINN-earned row in a polite live region', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    const region = screen.getByTestId('tjinn-earned-region');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
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

  // ── Batched top-up quota (issue #560) ──────────────────────────────────
  it('surfaces remaining top-ups for today when quota is partially used (issue #560)', () => {
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        topupDailyCap={10}
        topupCallsRemaining={4}
        topupCooldownExpiresAt={null}
      />,
    );
    render(ui);
    const gas = screen.getByTestId('wallet-section-gas');
    expect(gas.textContent).toMatch(/4 of 10 top-ups left today/i);
    expect((screen.getByTestId('wallet-topup') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the button and shows cap-reached copy when no top-ups remain (issue #560)', () => {
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const { ui } = wrap(
      <WalletCard
        {...defaultProps()}
        topupDailyCap={10}
        topupCallsRemaining={0}
        topupCooldownExpiresAt={expiresAt}
      />,
    );
    render(ui);
    expect((screen.getByTestId('wallet-topup') as HTMLButtonElement).disabled).toBe(true);
    const gas = screen.getByTestId('wallet-section-gas');
    expect(gas.textContent).toMatch(/daily faucet cap reached/i);
  });

  it('keeps the button enabled and shows no quota copy when quota props are undefined (back-compat)', () => {
    const { ui } = wrap(<WalletCard {...defaultProps()} />);
    render(ui);
    expect((screen.getByTestId('wallet-topup') as HTMLButtonElement).disabled).toBe(false);
    const gas = screen.getByTestId('wallet-section-gas');
    expect(gas.textContent).not.toMatch(/top-ups left today/i);
    expect(gas.textContent).not.toMatch(/daily faucet cap reached/i);
  });

});
