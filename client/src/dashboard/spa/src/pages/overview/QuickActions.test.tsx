import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('runs an action and shows success feedback', async () => {
    const onTopUp = vi.fn(async () => ({ message: 'Gas top-up requested.' }));
    render(
      <QuickActions
        claimableJinn="0"
        gasEth="0.005"
        onClaim={vi.fn()}
        onTopUp={onTopUp}
        onManage={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /top up gas/i }));

    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('quick-actions-notice')).textContent).toContain('Gas top-up requested.');
  });

  it('shows errors instead of failing silently', async () => {
    render(
      <QuickActions
        claimableJinn="0"
        gasEth="0.005"
        onClaim={async () => { throw new Error('Claim failed'); }}
        onTopUp={vi.fn()}
        onManage={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /claim jinn/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('Claim failed');
  });
});
