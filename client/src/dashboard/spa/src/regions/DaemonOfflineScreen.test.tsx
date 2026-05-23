/**
 * Unit tests for DaemonOfflineScreen (issue #110).
 *
 * Asserts: headline literal, `jinn run` code element, "Reconnecting…" text,
 * and the disclosure toggle revealing lastError.
 *
 * The component accepts only the disconnected variant of ConnectionState
 * (narrowed via DisconnectedState = Extract<ConnectionState, { status: 'disconnected' }>).
 * The "connected state" test has been removed since the type system now
 * forbids that input path.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DaemonOfflineScreen } from './DaemonOfflineScreen.js';
import type { ConnectionState } from '../api/connection-state.js';

type DisconnectedState = Extract<ConnectionState, { status: 'disconnected' }>;

const disconnected: DisconnectedState = {
  status: 'disconnected',
  since: Date.now() - 5000,
  lastError: 'TypeError: fetch failed',
  attempts: 3,
};

describe('DaemonOfflineScreen', () => {
  it('renders the "Daemon not running." headline', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    expect(screen.getByRole('heading').textContent).toBe('Daemon not running.');
  });

  it('renders a <code> element containing "jinn run"', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    const code = screen.getByText('jinn run');
    expect(code.tagName.toLowerCase()).toBe('code');
  });

  it('renders "Reconnecting" text', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    expect(screen.getByText(/Reconnecting/i)).toBeTruthy();
  });

  it('shows the attempt counter when attempts > 0', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    expect(screen.getByText(/attempt 3/i)).toBeTruthy();
  });

  it('mounts with data-testid="daemon-offline-screen"', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    expect(screen.getByTestId('daemon-offline-screen')).toBeTruthy();
  });

  it('disclosure toggle reveals lastError', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    // Error not visible before toggle
    expect(screen.queryByText('TypeError: fetch failed')).toBeNull();
    // Click "Show details"
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('TypeError: fetch failed')).toBeTruthy();
  });

  it('disclosure toggle hides details after second click', () => {
    render(<DaemonOfflineScreen connection={disconnected} />);
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('TypeError: fetch failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Hide details'));
    expect(screen.queryByText('TypeError: fetch failed')).toBeNull();
  });
});
