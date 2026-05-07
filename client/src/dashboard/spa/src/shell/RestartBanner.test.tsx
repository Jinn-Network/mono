import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RestartBanner } from './RestartBanner.js';

describe('RestartBanner', () => {
  it('renders nothing when no restart is pending', () => {
    const { container } = render(<RestartBanner restartPending={false} onRestart={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders message and Restart button when pending', () => {
    const onRestart = vi.fn();
    render(<RestartBanner restartPending={true} onRestart={onRestart} />);
    expect(screen.getByText(/operator settings saved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /restart node/i }));
    expect(onRestart).toHaveBeenCalledOnce();
  });
});
