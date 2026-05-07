import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

describe('HeroStats', () => {
  it('renders three stat cards (Tasks / JINN / Gas)', () => {
    render(
      <HeroStats
        tasksDelivered={42}
        jinnEarned="123"
        gasRunwayDays={4}
      />,
    );
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    // Node Status used to live here; it's now in <LiveNowBand />.
    expect(screen.queryByText(/node status/i)).toBeNull();
  });
});
