import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkCard } from './NetworkCard.js';

describe('NetworkCard', () => {
  it('renders the network counters with no operator-specific state', () => {
    render(
      <NetworkCard
        name="prediction"
        totals={{ tasks: 12, active: 3, solutions: 9, verdicts: 8, settledFailed: 1, localErrors: 2 }}
      />,
    );
    expect(screen.getByText(/network · prediction/i)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.queryByText(/role/i)).toBeNull();
    expect(screen.queryByText(/view/i)).toBeNull();
  });

  it('surfaces on-chain settled failures and local engine errors as separate stats', () => {
    render(
      <NetworkCard
        name="prediction"
        totals={{ tasks: 30, active: 0, solutions: 12, verdicts: 8, settledFailed: 3, localErrors: 7 }}
      />,
    );
    // Both labels render, replacing the prior single "failed" stat.
    expect(screen.getByText(/settled fail/i)).toBeTruthy();
    expect(screen.getByText(/local err/i)).toBeTruthy();
    expect(screen.queryByText(/^failed$/i)).toBeNull();
    // Each count surfaces under its dedicated label, distinguishable when
    // the two values differ.
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('renders zero counts without the warn tone', () => {
    render(
      <NetworkCard
        name="prediction"
        totals={{ tasks: 5, active: 1, solutions: 4, verdicts: 0, settledFailed: 0, localErrors: 0 }}
      />,
    );
    // Both failure stats render as zero — no warn tone needed.
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3);
  });
});
