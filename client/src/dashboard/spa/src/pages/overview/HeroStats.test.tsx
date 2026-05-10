import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

describe('HeroStats', () => {
  it('renders overview stats plus compact status', () => {
    render(
      <HeroStats
        tasksDelivered={42}
        jinnEarned="123"
        gasRunwayDays={4}
        statusLabel="WORKING"
        statusState="working"
        statusDot="var(--vow-green)"
      />,
    );
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('WORKING')).toBeTruthy();
    expect(screen.getByTestId('overview-status-stat').getAttribute('data-state')).toBe('working');
    // The full live card now lives on /operator.
    expect(screen.queryByText(/node status/i)).toBeNull();
  });
});
