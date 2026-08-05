import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router, Route, Switch, Redirect, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.js';
import { api } from './api/client.js';
import type { BootstrapState } from './../../../api/contract/index.js';
import { OverviewPage } from './pages/Overview.js';
import { EventsPage } from './pages/Events.js';
import { EventDetailPage } from './pages/EventDetail.js';
import { LauncherPage } from './pages/Launcher.js';
import { LauncherCreatePage } from './pages/LauncherCreate.js';
import { LauncherLaunchedPage } from './pages/LauncherLaunched.js';
import { getFeatures } from './lib/features.js';
import { OperatorShell } from './pages/operator/OperatorShell.js';
import { MembershipsTab } from './pages/operator/MembershipsTab.js';
import { RegistryTab } from './pages/operator/RegistryTab.js';
import { NetworkTab } from './pages/operator/NetworkTab.js';
import { SecurityTab } from './pages/operator/SecurityTab.js';

import type { JSX } from 'react';

// ActivitySections now uses SSE — mock so routing tests don't open EventSource.
vi.mock('./api/events.js', () => ({
  useEventStream: vi.fn(() => ({ events: [], connected: false })),
}));

// Operator + Overview + Launcher pages all useQuery for the daemon API;
// mock so the routing tests don't depend on a live server.
vi.mock('./api/client.js', () => ({
  api: {
    // Wrap as vi.fn so individual tests can call `vi.mocked(api.getBootstrap)
    // .mockResolvedValue(...)` to drive App into operating mode. Per-test
    // overrides are reset in the `afterEach` below.
    getBootstrap: vi.fn(async () => ({})),
    getStatus: async () => ({ activity: { counts: {}, recent: [] } }),
    getActivityEvents: async () => ({ events: [], nextCursor: null, counts: {} }),
    getActivityEvent: async () => ({
      id: 1,
      ts: '2026-05-01T00:00:00Z',
      kind: 'task_posted',
      requestId: 'req-1',
      serviceIndex: null,
      txHash: null,
      solverType: null,
      outcome: 'ok',
      detail: null,
    }),
    getSolverNets: async () => ({ schemaVersion: 1, generatedAt: '', nets: [] }),
    restartDaemon: async () => ({ ok: true }),
    operator: {
      listArtifacts: async () => ({
        schemaVersion: 1,
        generatedAt: '2026-05-07T00:00:00.000Z',
        source: 'served',
        pricing: {
          publicEndpoint: 'https://op.example.com',
          defaultPriceUsdc: '0',
          perArtifactTypePrice: {},
          donation: { enabled: false },
        },
        summary: {
          served: {
            totalCount: 0,
            totalBytes: 0,
            freeCount: 0,
            gatedCount: 0,
            latestCreatedAt: null,
            artifactTypes: [],
          },
          network: {
            totalCount: 0,
            totalBytes: 0,
            latestFetchedAt: null,
            artifactTypes: [],
          },
          access: {
            accessCount: 0,
            paidServeCount: 0,
            freeServeCount: 0,
            failedPaymentCount: 0,
            paymentRequiredCount: 0,
            revenueUsdc: '0',
            lastAccessAt: null,
            lastPaidAt: null,
          },
        },
        recentAccesses: [],
        artifacts: [],
      }),
      updatePricing: async () => ({ ok: true, restartRequired: true }),
      listJoined: async () => ({ joinedSolverNets: {} }),
      join: async () => ({ ok: true, restartRequired: true, manifestCid: '', config: { manifestCid: '', roles: [] } }),
      leave: async () => ({ ok: true, restartRequired: true, manifestCid: '' }),
    },
    solvernets: {
      listDrafts: async () => ({ drafts: [] }),
      getDraft: async () => ({}),
      createDraft: async () => ({
        schemaVersion: 'solvernet.draft.v1',
        draftId: 'd-routing-test',
        completedSteps: [],
        createdAt: '2026-05-05T00:00:00Z',
        updatedAt: '2026-05-05T00:00:00Z',
      }),
      updateDraft: async () => ({}),
      deleteDraft: async () => ({ ok: true }),
      launch: async () => ({ solverNetId: '', status: 'launching', pollUrl: '' }),
      transitionLifecycle: async () => ({}),
      updateGeneratorConfig: async () => ({}),
      get: async () => ({}),
      listLaunched: async () => ({ records: [] }),
      listRegistry: async () => ({ summaries: [], lastRefreshedAt: null, lastError: null }),
      getManifest: async () => ({}),
    },
  },
}));

function withProviders(node: JSX.Element, path: string): JSX.Element {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

describe('App routes', () => {
  it('renders OverviewPage on /overview', () => {
    render(
      withProviders(
        <Switch>
          <Route path="/overview"><OverviewPage /></Route>
        </Switch>,
        '/overview',
      ),
    );
    // Overview renders the Node Health card in the right rail and the
    // consolidated Wallet card (Gas + Rewards + Identity + Password) in
    // the main column.
    expect(screen.getByText(/^node health$/i)).toBeTruthy();
    expect(screen.getByText(/^wallet$/i)).toBeTruthy();
    expect(screen.getByText(/^rewards$/i)).toBeTruthy();
  });

  it('renders the durable Events page on /events', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/events/:id"><EventDetailPage /></Route>
          <Route path="/events"><EventsPage /></Route>
          <Route path="/overview"><OverviewPage /></Route>
        </Switch>,
        '/events',
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('events-page')).toBeTruthy();
    });
  });

  it('renders the event detail page on /events/:id', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/events/:id"><EventDetailPage /></Route>
          <Route path="/events"><EventsPage /></Route>
        </Switch>,
        '/events/1',
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /task posted/i })).toBeTruthy();
    });
  });

  it('renders LauncherPage on /launcher', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/launcher/create"><LauncherCreatePage /></Route>
          <Route path="/launcher/launched/:solverNetId">
            <LauncherLaunchedPage />
          </Route>
          <Route path="/launcher"><LauncherPage /></Route>
        </Switch>,
        '/launcher',
      ),
    );
    // No owned launched records yet -> empty state surfaces (spec §10).
    await waitFor(() =>
      expect(screen.getByText(/no solvernets created yet\./i)).toBeTruthy(),
    );
  });

  // ── New SolverNet creation/launch routes ──
  // /launcher/create renders the 5-step wizard (Task 18); /launcher/launched/:id
  // renders the post-launch dashboard (Task 19). The routing test asserts the
  // route matches and the dashboard shell mounts without crashing.

  it('renders LauncherCreatePage wizard on /launcher/create', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/launcher/create"><LauncherCreatePage /></Route>
          <Route path="/launcher/launched/:solverNetId">
            <LauncherLaunchedPage />
          </Route>
          <Route path="/launcher"><LauncherPage /></Route>
        </Switch>,
        '/launcher/create',
      ),
    );
    // The wizard shows a loading state while the draft is created on mount,
    // then advances to Step 1.
    expect(screen.getByTestId('launcher-create-loading')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('launcher-create-step-1')).toBeTruthy(),
    );
  });

  // ── /build feature gate (issue #327) ──
  // The /build route mirrors App.tsx: BuildPage when the pluginBuilderUi flag
  // is on, else a redirect to /overview. The substrate stays live; only the
  // operator-app promotion is gated.

  afterEach(() => {
    delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
    // Reset the bootstrap mock so per-test overrides don't leak across cases.
    // Restores the module-level stub from the `vi.mock('./api/client.js', …)`
    // factory (`getBootstrap: async () => ({})`).
    vi.mocked(api.getBootstrap).mockReset();
    vi.mocked(api.getBootstrap).mockResolvedValue({} as BootstrapState);
  });

  function LocationProbe(): JSX.Element {
    const [location] = useLocation();
    return <div data-testid="location">{location}</div>;
  }

  function BuildRoute(): JSX.Element {
    const pluginBuilderUi = getFeatures().pluginBuilderUi;
    return (
      <Switch>
        <Route path="/build">
          {pluginBuilderUi ? <div data-testid="build-page" /> : <Redirect to="/overview" />}
        </Route>
        <Route path="/overview"><LocationProbe /></Route>
      </Switch>
    );
  }

  it('redirects /build to /overview when the pluginBuilderUi flag is off (default)', async () => {
    render(withProviders(<BuildRoute />, '/build'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/overview'),
    );
    expect(screen.queryByTestId('build-page')).toBeNull();
  });

  it('renders the build page on /build when the pluginBuilderUi flag is on', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true };
    render(withProviders(<BuildRoute />, '/build'));
    expect(screen.getByTestId('build-page')).toBeTruthy();
  });

  it('renders LauncherLaunchedPage on /launcher/launched/:solverNetId and exposes the param', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/launcher/create"><LauncherCreatePage /></Route>
          <Route path="/launcher/launched/:solverNetId">
            <LauncherLaunchedPage />
          </Route>
          <Route path="/launcher"><LauncherPage /></Route>
        </Switch>,
        '/launcher/launched/agent-1_prediction.v1-1_abcdef01',
      ),
    );
    // The dashboard polls `api.solvernets.get(:id)` on mount; while the query
    // is in flight the loading state shows. Once the mocked stub resolves the
    // record query falls into the error path (the stub returns `{}`); either
    // way the route is mounted under its outermost test id.
    await waitFor(() =>
      expect(
        screen.queryByTestId('launcher-launched-loading') ??
          screen.queryByTestId('launcher-launched-error') ??
          screen.queryByTestId('launcher-launched'),
      ).toBeTruthy(),
    );
  });

  // ── Operator sub-routes (Task 5.1) ──
  // The four new sub-routes resolve to their stub tabs wrapped in OperatorShell.
  // Bare /operator redirects to /operator/memberships.

  function OperatorSubSwitch(): JSX.Element {
    return (
      <Switch>
        <Route path="/operator/memberships">
          <OperatorShell><MembershipsTab /></OperatorShell>
        </Route>
        <Route path="/operator/registry">
          <OperatorShell><RegistryTab /></OperatorShell>
        </Route>
        <Route path="/operator/network">
          <OperatorShell><NetworkTab /></OperatorShell>
        </Route>
        <Route path="/operator/security">
          <OperatorShell><SecurityTab /></OperatorShell>
        </Route>
        <Route path="/operator">
          <Redirect to="/operator/memberships" />
        </Route>
        <Route path="/overview"><LocationProbe /></Route>
      </Switch>
    );
  }

  it('renders MembershipsTab on /operator/memberships', () => {
    render(withProviders(<OperatorSubSwitch />, '/operator/memberships'));
    expect(screen.getByTestId('memberships-tab')).toBeTruthy();
    expect(screen.getByTestId('operator-shell')).toBeTruthy();
  });

  it('renders RegistryTab on /operator/registry', () => {
    render(withProviders(<OperatorSubSwitch />, '/operator/registry'));
    expect(screen.getByTestId('registry-tab')).toBeTruthy();
    expect(screen.getByTestId('operator-shell')).toBeTruthy();
  });

  it('renders NetworkTab on /operator/network', () => {
    render(withProviders(<OperatorSubSwitch />, '/operator/network'));
    expect(screen.getByTestId('network-tab')).toBeTruthy();
    expect(screen.getByTestId('operator-shell')).toBeTruthy();
  });

  it('renders SecurityTab on /operator/security', () => {
    render(withProviders(<OperatorSubSwitch />, '/operator/security'));
    expect(screen.getByTestId('security-tab')).toBeTruthy();
    expect(screen.getByTestId('operator-shell')).toBeTruthy();
  });

  it('redirects bare /operator to /operator/memberships', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/operator/memberships"><LocationProbe /></Route>
          <Route path="/operator"><Redirect to="/operator/memberships" /></Route>
        </Switch>,
        '/operator',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/operator/memberships'),
    );
  });

  // Mounts the real `App` (default export) so this test exercises the
  // production routing table from App.tsx — not the local OperatorSubSwitch
  // fixture above, which rebuilds its own Switch.
  //
  // Contract being locked in: the four `/operator/{memberships,registry,
  // network,security}` sub-routes must be listed BEFORE the bare-`/operator`
  // redirect in App.tsx's Switch. If a future refactor reorders the Switch
  // so the bare-`/operator` redirect catches first, /operator/network would
  // wrongly redirect to /operator/memberships and this test would fail.
  // That's intentional — don't "fix" it by deleting the test; fix the
  // ordering in App.tsx.
  it('routes /operator/network directly to NetworkTab without shadow from the bare-/operator redirect', async () => {
    // App reads bootstrap on mount; in running mode it renders the operator
    // Switch. Use mockResolvedValue (not Once) because App.tsx schedules a
    // 1.5s refetch on the ['bootstrap'] query and we don't want the second
    // resolution to fall back to the module-level `{}` stub (which would
    // collapse App into Onboarding mid-test). wouter Routers are nestable —
    // the outer `memoryLocation` hook from `withProviders` wins over the
    // inner `<Router>` App mounts itself.
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      // #983: the running-mode → <Operating> gate now requires onboarding to be
      // complete (else App holds the onboarding takeover). Set the flag so this
      // routing test reaches the operator Switch.
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
      onboardingComplete: true,
    } as unknown as BootstrapState);
    render(withProviders(<App />, '/operator/network'));
    await waitFor(() => expect(screen.getByTestId('network-tab')).toBeTruthy());
    expect(screen.queryByTestId('memberships-tab')).toBeNull();
  });

  // ── #983: onboarding completion overlay ──
  // The daemon flips mode→running purely on the earning state machine; a node
  // that finished bootstrap but has not completed onboarding is live-but-idle.
  // A mid-onboarding node may already carry a membership (the first join
  // populates joinedSolverNets) yet not have finished the harness/model step,
  // so App holds the takeover on an explicit onboardingComplete flag rather
  // than on joinedSolverNets being non-empty.

  it('holds Onboarding when running but onboarding is not complete (#983)', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      currentStep: 'complete',
      services: [],
      steps: [],
      schemaVersion: 1,
      // A mid-onboarding node may already have a membership (first join populates
      // it) yet not have finished — onboardingComplete is still false/absent.
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
    } as unknown as BootstrapState);
    render(withProviders(<App />, '/overview'));
    await waitFor(() => expect(screen.getByTestId('onboarding-progress')).toBeTruthy());
    expect(screen.queryByTestId('network-tab')).toBeNull();
  });

  it('routes to <Operating> when running and onboarding is complete (#983)', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
      onboardingComplete: true,
    } as unknown as BootstrapState);
    render(withProviders(<App />, '/operator/network'));
    await waitFor(() => expect(screen.getByTestId('network-tab')).toBeTruthy());
    expect(screen.queryByTestId('onboarding-progress')).toBeNull();
  });
});
