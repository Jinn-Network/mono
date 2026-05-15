import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

function defaultProps() {
  return {
    tasksDelivered: 42,
    jinnClaimable: '123',
    gasBalanceEth: '0.5000',
    gasRunwayDays: 4,
    statusLabel: 'WORKING',
    statusState: 'working' as const,
    statusDot: 'var(--vow-green)',
    activeAction: null,
    evicted: false,
    onClaim: () => undefined,
    onTopUp: () => undefined,
    onRestart: () => undefined,
  };
}

describe('HeroStats', () => {
  it('renders overview stats plus compact status', () => {
    render(<HeroStats {...defaultProps()} />);
    expect(screen.getByText(/solutions delivered/i)).toBeTruthy();
    expect(screen.getByText(/jinn claimable/i)).toBeTruthy();
    expect(screen.queryByText(/jinn earned/i)).toBeNull();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('0.5000')).toBeTruthy();
    expect(screen.getByText(/4 days runway/i)).toBeTruthy();
    expect(screen.getByText('WORKING')).toBeTruthy();
    expect(screen.getByRole('button', { name: /claim now/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /top up/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restart/i })).toBeTruthy();
    expect(screen.getByTestId('overview-status-stat').getAttribute('data-state')).toBe('working');
    // The full live card now lives on /operator.
    expect(screen.queryByText(/node status/i)).toBeNull();
  });

  it('disables Claim now CTA when evicted=true and renders eviction notice (jinn-mono-hjex.3)', () => {
    render(<HeroStats {...defaultProps()} evicted={true} />);
    const claimBtn = screen.getByRole('button', { name: /claim now/i });
    // Button must be disabled when service is evicted
    expect(claimBtn).toHaveProperty('disabled', true);
    // Eviction explainer must be visible — no OLAS mention
    expect(screen.getByText(/service evicted/i)).toBeTruthy();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
  });

  it('does not show eviction notice when evicted=false (jinn-mono-hjex.3)', () => {
    render(<HeroStats {...defaultProps()} evicted={false} />);
    expect(screen.queryByText(/service evicted/i)).toBeNull();
  });

  it('renders Re-stake now button when evicted=true with serviceId and onRestake (jinn-mono-hjex.3)', () => {
    const onRestake = vi.fn().mockResolvedValue(undefined);
    render(
      <HeroStats
        {...defaultProps()}
        evicted={true}
        evictedServiceId={42}
        onRestake={onRestake}
      />,
    );
    expect(screen.getByTestId('restake-button')).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-stake now/i })).toBeTruthy();
  });

  it('calls onRestake with serviceId when Re-stake now is clicked (jinn-mono-hjex.3)', () => {
    const onRestake = vi.fn().mockResolvedValue(undefined);
    render(
      <HeroStats
        {...defaultProps()}
        evicted={true}
        evictedServiceId={42}
        onRestake={onRestake}
      />,
    );
    const restakeBtn = screen.getByRole('button', { name: /re-stake now/i });
    fireEvent.click(restakeBtn);
    expect(onRestake).toHaveBeenCalledWith(42);
  });

  it('does not render Re-stake now button when evicted=true but onRestake is not provided (jinn-mono-hjex.3)', () => {
    render(<HeroStats {...defaultProps()} evicted={true} evictedServiceId={42} />);
    expect(screen.queryByTestId('restake-button')).toBeNull();
  });
});
