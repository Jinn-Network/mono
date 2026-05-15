import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

describe('HeroStats', () => {
  it('renders overview stats plus compact status', () => {
    render(
      <HeroStats
        tasksDelivered={42}
        jinnClaimable="123"
        gasBalanceEth="0.5000"
        gasRunwayDays={4}
        statusLabel="WORKING"
        statusState="working"
        statusDot="var(--vow-green)"
        activeAction={null}
        onClaim={() => undefined}
        onTopUp={() => undefined}
        onRestart={() => undefined}
      />,
    );
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
});
