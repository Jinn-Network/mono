/**
 * Issue #110 — App-gate: the SPA pre-running gate must distinguish three
 * connection/data states and route to the correct screen, eliminating the
 * "Starting jinn / no events yet" dead-end when the daemon has already exited.
 *
 * AC1: daemon offline (connection.status === 'disconnected', no data) → DaemonOfflineScreen.
 * AC2: daemon connected, uninitialized + funding_required error → Onboarding.
 * AC3 (happy LoadingScreen): daemon connected, no data yet → LoadingScreen.
 * AC3 (disconnected hides "Starting jinn"): disconnected state must NOT show LoadingScreen.
 *
 * Mock strategy: use module-level vi.mock with mutable state objects. Each
 * test overrides the `_state` refs before rendering, then resets afterEach.
 * This avoids the "vi.mock inside function not hoisted" pitfall.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── Mutable state for connection + bootstrap ──────────────────────────────────

type ConnectionState =
  | { status: 'connected'; lastConnectedAt: number }
  | { status: 'disconnected'; since: number; lastError: string | null; attempts: number };

let _connectionState: ConnectionState = { status: 'connected', lastConnectedAt: 0 };
let _bootstrapResolver: ((v: unknown) => void) | null = null;
let _bootstrapRejecter: ((e: Error) => void) | null = null;

// ── Top-level vi.mock calls (hoisted by Vitest) ───────────────────────────────

vi.mock('./api/connection-state.js', () => ({
  useConnectionState: () => _connectionState,
}));

vi.mock('./api/client.js', () => ({
  api: {
    getBootstrap: () =>
      new Promise((res, rej) => {
        _bootstrapResolver = res as (v: unknown) => void;
        _bootstrapRejecter = rej;
      }),
    getStatus: () => Promise.resolve({}),
  },
}));

// jsdom has no EventSource — stub the SSE hook the OfflineNotice→useNotifications
// chain depends on (mirrors notifications/useNotifications.test.tsx).
vi.mock('./api/events.js', () => ({
  useEventStream: () => ({ events: [], connected: false }),
}));

// Stub regions as marker divs.
vi.mock('./regions/LoadingScreen.js', () => ({
  LoadingScreen: ({ headline }: { headline?: string }) => (
    <div data-testid="loading-screen" data-headline={headline ?? ''}>
      {headline}
    </div>
  ),
}));

vi.mock('./regions/Onboarding.js', () => ({
  Onboarding: () => <div data-testid="onboarding" />,
}));

vi.mock('./regions/DaemonOfflineScreen.js', () => ({
  DaemonOfflineScreen: ({ connection }: { connection: ConnectionState }) => (
    <div
      data-testid="daemon-offline-screen"
      data-attempts={connection.status === 'disconnected' ? connection.attempts : undefined}
    />
  ),
}));

// Stub shell + pages.
vi.mock('./shell/AppShell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));
vi.mock('./shell/Header.js', () => ({ Header: () => null }));
vi.mock('./shell/TopTabs.js', () => ({ TopTabs: () => null }));
vi.mock('./shell/AgentRail.js', () => ({ AgentRail: () => null }));
vi.mock('./shell/RestartPendingContext.js', () => ({
  RestartPendingContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
  useRestartPending: () => ({ restartPending: false, setRestartPending: () => {} }),
}));
vi.mock('./pages/Overview.js', () => ({ OverviewPage: () => null }));
vi.mock('./pages/Launcher.js', () => ({ LauncherPage: () => null }));
vi.mock('./pages/LauncherCreate.js', () => ({ LauncherCreatePage: () => null }));
vi.mock('./pages/LauncherLaunched.js', () => ({ LauncherLaunchedPage: () => null }));
vi.mock('./captures/CapturesTab.js', () => ({ CapturesTab: () => null }));
vi.mock('./pages/operator/OperatorShell.js', () => ({
  OperatorShell: () => null,
}));
vi.mock('./pages/operator/MembershipsTab.js', () => ({ MembershipsTab: () => null }));
vi.mock('./pages/operator/RegistryTab.js', () => ({ RegistryTab: () => null }));
vi.mock('./pages/operator/NetworkTab.js', () => ({ NetworkTab: () => null }));
vi.mock('./pages/operator/SecurityTab.js', () => ({ SecurityTab: () => null }));
vi.mock('./pages/Build.js', () => ({ BuildPage: () => null }));
vi.mock('./components/ui/tooltip.js', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ui/sonner.js', () => ({ Toaster: () => null }));
vi.mock('./lib/features.js', () => ({
  getFeatures: () => ({ pluginBuilderUi: false, embeddedAgent: false }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderApp(): Promise<void> {
  const { default: App } = await import('./App.js');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Reset to optimistic defaults before each test.
  _connectionState = { status: 'connected', lastConnectedAt: 0 };
  _bootstrapResolver = null;
  _bootstrapRejecter = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App gate — issue #110', () => {
  it('AC1 — disconnected + no data → renders DaemonOfflineScreen, not LoadingScreen', async () => {
    _connectionState = { status: 'disconnected', attempts: 3, lastError: 'fetch failed', since: 0 };
    await renderApp();
    // Reject the bootstrap promise to simulate no data + fetch failure
    _bootstrapRejecter?.(new Error('fetch failed'));
    await waitFor(() => expect(screen.queryByTestId('daemon-offline-screen')).toBeTruthy());
    expect(screen.queryByTestId('loading-screen')).toBeNull();
    // AC3 sub-check: "Starting jinn" copy must not be in DOM
    expect(screen.queryByText(/Starting jinn/i)).toBeNull();
  });

  it('AC2 — connected + uninitialized with funding_required error → renders Onboarding', async () => {
    _connectionState = { status: 'connected', lastConnectedAt: Date.now() };
    await renderApp();
    // Resolve with an uninitialized + error envelope
    _bootstrapResolver?.({
      mode: 'uninitialized',
      schemaVersion: 1,
      steps: [],
      currentStep: 'wallet',
      services: [],
      error: {
        schemaVersion: 1,
        code: 'funding_required',
        exitCode: 10,
        message: 'EOA needs ETH',
        generatedAt: new Date().toISOString(),
      },
    });
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeTruthy());
    expect(screen.queryByTestId('loading-screen')).toBeNull();
    expect(screen.queryByTestId('daemon-offline-screen')).toBeNull();
  });

  it('AC3 — connected + loading (no data yet) → renders LoadingScreen with "Starting jinn"', async () => {
    _connectionState = { status: 'connected', lastConnectedAt: Date.now() };
    await renderApp();
    // Bootstrap promise never resolves — we stay in the loading state
    // The loading screen renders immediately (isLoading + no data + connected)
    expect(screen.getByTestId('loading-screen')).toBeTruthy();
    const el = screen.getByTestId('loading-screen');
    expect(el.getAttribute('data-headline')).toContain('Starting jinn');
  });

  it('AC3 — disconnected state does not show "Starting jinn"', async () => {
    _connectionState = { status: 'disconnected', attempts: 1, lastError: 'fetch failed', since: Date.now() };
    await renderApp();
    _bootstrapRejecter?.(new Error('fetch failed'));
    await waitFor(() => expect(screen.queryByTestId('daemon-offline-screen')).toBeTruthy());
    expect(screen.queryByText(/Starting jinn/i)).toBeNull();
  });

  it('AC1-regression — disconnected + stale cached data → Onboarding, not DaemonOfflineScreen', async () => {
    // react-query keeps the last successful response in cache even when
    // subsequent refetches fail. The gate `connection.status === 'disconnected'
    // && !data` must NOT flip to DaemonOfflineScreen when cached data exists —
    // we already have enough to render Onboarding (or the running app).
    _connectionState = { status: 'disconnected', attempts: 2, lastError: 'fetch failed', since: Date.now() };
    await renderApp();
    // Resolve with a cached setup-mode payload — simulates react-query serving
    // its last known good value while the refetch probe is failing.
    _bootstrapResolver?.({
      schemaVersion: 1,
      mode: 'setup',
      steps: [],
      currentStep: 'wallet',
      services: [],
      chain: 'base-sepolia',
    });
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeTruthy());
    expect(screen.queryByTestId('daemon-offline-screen')).toBeNull();
  });

  it('#443 — Onboarding branch surfaces the offline signal when daemon dies after first poll', async () => {
    // Daemon died after a successful first poll: react-query serves cached
    // setup-mode data, connection flips to disconnected. The gate lands in the
    // Onboarding branch — which must still render the blocking offline notice.
    _connectionState = { status: 'disconnected', attempts: 2, lastError: 'fetch failed', since: Date.now() };
    await renderApp();
    _bootstrapResolver?.({
      schemaVersion: 1,
      mode: 'setup',
      steps: [],
      currentStep: 'wallet',
      services: [],
      chain: 'base-sepolia',
    });
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeTruthy());
    expect(screen.queryByText(/Daemon offline/i)).toBeTruthy();
    expect(screen.queryByTestId('daemon-offline-screen')).toBeNull();
  });
});
