import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionState } from './api/connection-state.js';

/**
 * Issue #335 — the OfflineBanner must surface a dead daemon in *every* App
 * render branch, not just the operating shell. These tests prove the banner
 * is mounted while the operator is still bootstrapping (LoadingScreen and
 * Onboarding early-returns), the case the canonical review flagged: a daemon
 * that dies mid-bootstrap must not leave the SPA on a stale screen with no
 * offline signal.
 */

// The connection state is injected per-test so we can simulate a daemon
// that has died while bootstrap is still in flight.
let connectionState: ConnectionState = {
  status: 'connected',
  lastConnectedAt: 0,
};

vi.mock('./api/connection-state.js', () => ({
  useConnectionState: () => connectionState,
}));

// Bootstrap mode is injected per-test to drive the three App branches.
let bootstrapMode: 'uninitialized' | 'setup' | 'running' = 'uninitialized';

vi.mock('./api/client.js', () => ({
  api: {
    getBootstrap: async () => ({ mode: bootstrapMode }),
  },
}));

// The bootstrap sub-screens pull in heavy subtrees (event streams, queries).
// Stub them down to identifiable markers — this test only cares that the
// banner is co-mounted with whatever branch App selects.
vi.mock('./regions/LoadingScreen.js', () => ({
  LoadingScreen: ({ headline }: { headline: string }) => (
    <div data-testid="loading-screen">{headline}</div>
  ),
}));

vi.mock('./regions/Onboarding.js', () => ({
  Onboarding: () => <div data-testid="onboarding" />,
}));

const disconnected: ConnectionState = {
  status: 'disconnected',
  since: 0,
  lastError: 'network down',
  attempts: 2,
};

async function renderApp(): Promise<void> {
  const { default: App } = await import('./App.js');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.resetModules();
  connectionState = { status: 'connected', lastConnectedAt: 0 };
  bootstrapMode = 'uninitialized';
});

describe('App offline banner across bootstrap phases', () => {
  it('renders the OfflineBanner during the LoadingScreen branch when the daemon dies', async () => {
    bootstrapMode = 'uninitialized';
    connectionState = disconnected;
    await renderApp();

    // LoadingScreen branch is active …
    await waitFor(() =>
      expect(screen.getByTestId('loading-screen')).toBeTruthy(),
    );
    // … and the offline banner is co-mounted, not discarded.
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
  });

  it('renders the OfflineBanner during the Onboarding branch when the daemon dies', async () => {
    bootstrapMode = 'setup';
    connectionState = disconnected;
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('onboarding')).toBeTruthy());
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
  });

  it('shows no banner during bootstrap while the daemon is connected', async () => {
    bootstrapMode = 'setup';
    connectionState = { status: 'connected', lastConnectedAt: 0 };
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('onboarding')).toBeTruthy());
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});
