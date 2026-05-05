import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkCard } from './NetworkCard.js';

describe('NetworkCard', () => {
  it('renders the network counters with no operator-specific state', () => {
    render(
      <NetworkCard
        name="prediction"
        totals={{ tasks: 12, active: 3, solutions: 9, verdicts: 8, failed: 1 }}
      />,
    );
    expect(screen.getByText(/network · prediction/i)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.queryByText(/role/i)).toBeNull();
    expect(screen.queryByText(/view/i)).toBeNull();
  });
});
