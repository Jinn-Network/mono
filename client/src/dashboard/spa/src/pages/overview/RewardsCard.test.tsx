import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RewardsCard } from './RewardsCard.js';

const defaultProps = () => ({
  claimableJinn: '12.34',
  claimedJinnLifetime: '100.00',
  lastClaimAt: '2026-05-19T10:00:00Z' as string | null,
  onClaim: vi.fn(),
});

describe('RewardsCard (§2.7)', () => {
  it('renders claimable + claimed lifetime', () => {
    render(<RewardsCard {...defaultProps()} />);
    expect(screen.getByText(/claimable/i)).toBeTruthy();
    expect(screen.getByText('12.34')).toBeTruthy();
    expect(screen.getByText(/claimed/i)).toBeTruthy();
    expect(screen.getByText('100.00')).toBeTruthy();
  });

  it('disables Claim button when claimable is 0', () => {
    render(<RewardsCard {...defaultProps()} claimableJinn="0" />);
    const btn = screen.getByRole('button', { name: /claim/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('fires onClaim when the button is clicked', () => {
    const props = defaultProps();
    render(<RewardsCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /claim/i }));
    expect(props.onClaim).toHaveBeenCalledOnce();
  });

  it('does not render ETH or OLAS anywhere', () => {
    render(<RewardsCard {...defaultProps()} />);
    expect(screen.queryByText(/ETH/i)).toBeNull();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
  });

  it('handles null lastClaimAt without crashing', () => {
    render(<RewardsCard {...defaultProps()} lastClaimAt={null} />);
    expect(screen.getByRole('region', { name: /rewards/i })).toBeTruthy();
  });
});
