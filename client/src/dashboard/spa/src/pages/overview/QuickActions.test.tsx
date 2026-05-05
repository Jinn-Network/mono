import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuickActions } from './QuickActions.js';

describe('QuickActions', () => {
  it('renders four actions with the canonical labels', () => {
    render(
      <QuickActions
        claimableJinn="0"
        gasEth="0.005"
        onClaim={vi.fn()}
        onTopUp={vi.fn()}
        onManage={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText(/claim jinn/i)).toBeTruthy();
    expect(screen.getByText(/top up gas/i)).toBeTruthy();
    expect(screen.getByText(/manage wallet/i)).toBeTruthy();
    expect(screen.getByText(/restart node/i)).toBeTruthy();
  });
});
