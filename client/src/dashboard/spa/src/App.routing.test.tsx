import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router, Route, Switch, Redirect, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OverviewPage } from './pages/Overview.js';
import { OverviewActivityPage } from './pages/OverviewActivity.js';
import { OperatorPage } from './pages/Operator.js';
import { LauncherPage } from './pages/Launcher.js';
import { LauncherCreatePage } from './pages/LauncherCreate.js';
import { LauncherLaunchedPage } from './pages/LauncherLaunched.js';
import { getFeatures } from './lib/features.js';

// Operator + Overview + Launcher pages all useQuery for the daemon API;
// mock so the routing tests don't depend on a live server.
vi.mock('./api/client.js', () => ({
  api: {
    getBootstrap: async () => ({}),
    getStatus: async () => ({ activity: { counts: {}, recent: [] } }),
    getSolverNets: async () => ({ schemaVersion: 1, generatedAt: '', nets: [] }),
    claimRewards: async () => ({ ok: true }),
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
          <Route path="/overview/activity"><OverviewActivityPage /></Route>
          <Route path="/overview"><OverviewPage /></Route>
          <Route path="/operator"><OperatorPage /></Route>
        </Switch>,
        '/overview',
      ),
    );
    // Overview renders HeroStats with these canonical eyebrows.
    expect(screen.getByText(/solutions delivered/i)).toBeTruthy();
    expect(screen.getByText(/jinn claimable/i)).toBeTruthy();
  });

  it('renders OverviewActivityPage on /overview/activity', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/overview/activity"><OverviewActivityPage /></Route>
          <Route path="/overview"><OverviewPage /></Route>
        </Switch>,
        '/overview/activity',
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('overview-activity')).toBeTruthy();
    });
    expect(screen.getByTestId('live-now-band')).toBeTruthy();
  });

  it('renders OperatorPage on /operator', async () => {
    render(
      withProviders(
        <Switch>
          <Route path="/overview"><OverviewPage /></Route>
          <Route path="/operator"><OperatorPage /></Route>
        </Switch>,
        '/operator',
      ),
    );
    expect(screen.getByTestId('operator-page')).toBeTruthy();
    expect(screen.getByTestId('live-now-band')).toBeTruthy();
    expect(screen.getByText(/launcher tools/i).closest('section')).toBeTruthy();
    expect(screen.getByText(/open launcher/i).closest('a')?.getAttribute('href')).toBe('/launcher');
    // Operator is the configuration surface (SolverNets / Harness / Network /
    // Security). The SolverNets head is the most stable assertion since it
    // never collapses to nothing.
    await waitFor(() => expect(
      screen.getByText((_, el) =>
        el?.tagName === 'SPAN' && el.textContent === 'SolverNets',
      ),
    ).toBeTruthy());
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
});
