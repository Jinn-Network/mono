import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

describe('HeroStats', () => {
  it('renders four stat cards', () => {
    render(
      <HeroStats
        tasksDelivered={42}
        jinnEarned="123"
        gasRunwayDays={4}
        nodeStatus="Running"
      />,
    );
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});
