import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

function defaultProps() {
  return {
    tasksDelivered: 42,
    statusLabel: 'WORKING',
    statusState: 'working' as const,
    statusDot: 'var(--vow-green)',
    statusReason: '1 task restoring',
    activeAction: null,
    evicted: false,
    onRestart: () => undefined,
  };
}

describe('HeroStats', () => {
  it('renders solutions delivered stat and compact status tile', () => {
    render(<HeroStats {...defaultProps()} />);
    expect(screen.getByText(/solutions delivered/i)).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('WORKING')).toBeTruthy();
    expect(screen.getByRole('button', { name: /restart/i })).toBeTruthy();
    expect(screen.getByTestId('overview-status-stat').getAttribute('data-state')).toBe('working');
    // Funds + Rewards concerns are no longer in HeroStats — they live in
    // FundsCard and RewardsCard.
    expect(screen.queryByText(/jinn claimable/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /claim now/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /top up/i })).toBeNull();
    // The full live card now lives on /operator.
    expect(screen.queryByText(/node status/i)).toBeNull();
  });

  it('disables the Restart button while an action is in progress', () => {
    render(<HeroStats {...defaultProps()} activeAction="Restart node" />);
    const restartBtn = screen.getByRole('button', { name: /working/i });
    expect(restartBtn).toHaveProperty('disabled', true);
  });

  it('renders the eviction notice inside the STATUS tile when evicted=true (jinn-mono-hjex.3)', () => {
    render(<HeroStats {...defaultProps()} evicted={true} />);
    // Eviction explainer must be visible inside the STATUS tile — no OLAS mention
    expect(screen.getByText(/service evicted/i)).toBeTruthy();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
    // Eviction notice is inside the status stat tile
    const statusStat = screen.getByTestId('overview-status-stat');
    expect(statusStat.querySelector('span')?.textContent).not.toBeNull();
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

  // ── Status tile reason line ───────────────────────────────────────────────
  //
  // The STATUS hero tile renders `statusReason` (deriveLiveNow().line) as a
  // small subdued secondary line under the label so the operator sees *why*,
  // rather than only the bare label ("ATTENTION").
  it('renders the status reason line under the STATUS label', () => {
    render(<HeroStats {...defaultProps()} statusReason="1 task restoring" />);
    const reason = screen.getByTestId('overview-status-reason');
    expect(reason.textContent).toBe('1 task restoring');
    // The reason lives inside the STATUS tile, not elsewhere on the page.
    expect(screen.getByTestId('overview-status-stat').contains(reason)).toBe(true);
  });

  it('surfaces the attention reason so ATTENTION is never bare', () => {
    render(
      <HeroStats
        {...defaultProps()}
        statusLabel="ATTENTION"
        statusState="attention"
        statusDot="var(--break-red)"
        statusReason="Harness does not support prediction.v1"
      />,
    );
    expect(screen.getByText('ATTENTION')).toBeTruthy();
    expect(screen.getByTestId('overview-status-reason').textContent).toBe(
      'Harness does not support prediction.v1',
    );
  });

  it('renders the reason line in non-attention states too', () => {
    render(
      <HeroStats
        {...defaultProps()}
        statusLabel="IDLE"
        statusState="idle"
        statusDot="var(--fg-muted)"
        statusReason="waiting for next task"
      />,
    );
    expect(screen.getByTestId('overview-status-reason').textContent).toBe(
      'waiting for next task',
    );
  });

  it('omits the reason line when statusReason is empty', () => {
    render(<HeroStats {...defaultProps()} statusReason="" />);
    expect(screen.queryByTestId('overview-status-reason')).toBeNull();
  });
});
