import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner.js';
import type { ConnectionState } from '../api/connection-state.js';

const connected: ConnectionState = {
  status: 'connected',
  lastConnectedAt: Date.now(),
};

const disconnected: ConnectionState = {
  status: 'disconnected',
  since: Date.now(),
  lastError: 'probe failed',
  attempts: 3,
};

describe('OfflineBanner', () => {
  it('renders nothing while the daemon is connected', () => {
    const { container } = render(<OfflineBanner connection={connected} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('surfaces the offline state and a restart CTA when disconnected', () => {
    render(<OfflineBanner connection={disconnected} />);
    const banner = screen.getByTestId('offline-banner');
    expect(banner).toBeTruthy();
    // role=alert so assistive tech announces the dead-daemon condition.
    expect(banner.getAttribute('role')).toBe('alert');
    expect(screen.getByText(/daemon offline/i)).toBeTruthy();
    expect(screen.getByText(/reconnecting automatically/i)).toBeTruthy();
    // Plain-speech CTA: the operator needs to know to re-run the node.
    expect(screen.getByText('jinn run')).toBeTruthy();
  });
});
