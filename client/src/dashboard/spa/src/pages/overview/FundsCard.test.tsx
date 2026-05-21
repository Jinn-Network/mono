import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FundsCard } from './FundsCard.js';

const defaultProps = () => ({
  totalEth: '0.0500',
  runwayDays: 5,
  perRole: {
    master: '0.0400',
    agent: '0.0070',
    safe: '0.0030',
  },
  lastPasswordRotationAt: '2026-02-20T00:00:00Z' as string | null,
  onTopUp: vi.fn(),
  onChangePassword: vi.fn(),
});

describe('FundsCard (§2.3)', () => {
  it('renders ETH only — no OLAS, no JINN', () => {
    render(<FundsCard {...defaultProps()} />);
    expect(screen.getByText('0.0500')).toBeTruthy();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
    expect(screen.queryByText(/JINN/i)).toBeNull();
  });

  it('renders runway in days', () => {
    render(<FundsCard {...defaultProps()} />);
    expect(screen.getByText(/5\s*d.*runway|runway.*5/i)).toBeTruthy();
  });

  it('renders per-role drill-down on expansion (master / agent / safe)', () => {
    render(<FundsCard {...defaultProps()} />);
    // collapsed by default — per-role values not visible
    expect(screen.queryByText('0.0400')).toBeNull();
    // expand
    fireEvent.click(screen.getByRole('button', { name: /per role|drill-down|show details/i }));
    expect(screen.getByText('0.0400')).toBeTruthy();
    expect(screen.getByText('0.0070')).toBeTruthy();
    expect(screen.getByText('0.0030')).toBeTruthy();
  });

  it('exposes top-up + change-password actions', () => {
    const props = defaultProps();
    render(<FundsCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /top up|request funds/i }));
    expect(props.onTopUp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(props.onChangePassword).toHaveBeenCalledOnce();
  });

  it('handles null lastPasswordRotationAt without crashing', () => {
    render(<FundsCard {...defaultProps()} lastPasswordRotationAt={null} />);
    // should render something like "never" or just omit the line
    expect(screen.getByRole('region', { name: /funds/i })).toBeTruthy();
  });
});
