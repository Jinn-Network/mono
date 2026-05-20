import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Router, Route, Switch, Redirect } from 'wouter';
import { api } from './api/client.js';
import type { BootstrapState } from './api/types.js';
import { useConnectionState } from './api/connection-state.js';
import { LoadingScreen } from './regions/LoadingScreen.js';
import { Onboarding } from './regions/Onboarding.js';
import { AppShell } from './shell/AppShell.js';
import { Header } from './shell/Header.js';
import { TopTabs } from './shell/TopTabs.js';
import { AgentRail } from './shell/AgentRail.js';
import { RestartBanner } from './shell/RestartBanner.js';
import { OfflineBanner } from './shell/OfflineBanner.js';
import { OverviewPage } from './pages/Overview.js';
import { OverviewActivityPage } from './pages/OverviewActivity.js';
import { OperatorPage } from './pages/Operator.js';
import { LauncherPage } from './pages/Launcher.js';
import { LauncherCreatePage } from './pages/LauncherCreate.js';
import { LauncherLaunchedPage } from './pages/LauncherLaunched.js';
import { JoinFlow } from './pages/operator-catalog/JoinFlow.js';
import { CapturesTab } from './captures/CapturesTab.js';
import { BuildPage } from './pages/Build.js';
import { getFeatures } from './lib/features.js';

// Canonical routes enumerated in ./routes.ts — T1.4 imports that list for
// route-smoke coverage. Keep ROUTES in sync whenever the Switch below changes.

/**
 * App routes between two distinct phases of operator life:
 *
 *   Onboarding — bootstrap not yet 'running'. A focused, full-screen flow.
 *
 *   Operating  — bootstrap complete. A persistent shell (header, top tabs,
 *                agent rail) wraps top-level workspaces: /overview,
 *                /operator, and /launcher. The operator's relationship with
 *                the agent stays continuous across all pages.
 */
export default function App(): JSX.Element {
  const { data, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 1500,
  });
  const [restartPending, setRestartPending] = useState(false);
  // #335: detect a dead daemon so the operating shell stops silently
  // rendering stale state. The probe runs regardless of bootstrap phase.
  const connection = useConnectionState();

  // #335: the OfflineBanner must surface a dead daemon in *every* render
  // branch, not just the operating shell. If the daemon dies while the
  // operator is still bootstrapping, the loading/onboarding screens would
  // otherwise sit stale with no offline signal — the exact "UI lies about
  // daemon state" failure #335 names. Hoist the banner above all three
  // branches so it is reachable regardless of bootstrap phase.
  if (isLoading || !data || data.mode === 'uninitialized') {
    const headline = !data
      ? 'Starting jinn'
      : data.mode === 'uninitialized'
        ? 'Setting up your wallet'
        : 'Loading';
    return (
      <>
        <OfflineBanner connection={connection} />
        <LoadingScreen headline={headline} />
      </>
    );
  }

  if (data.mode !== 'running') {
    return (
      <>
        <OfflineBanner connection={connection} />
        <Onboarding />
      </>
    );
  }

  const network = (data.chain === 'base' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet';
  const masterAddress = data.master_address ?? '';

  // Issue #327: the builder surfaces (/build route + Build top-tab) are hidden
  // until the operator-app first-run UX is solid. The plug-in substrate stays
  // live for direct-CLI builders; only the operator-app promotion is gated.
  // Set JINN_ENABLE_PLUGIN_BUILDER_UI=1 on the daemon to re-enable.
  //
  // Issue #326 / #367: the embedded agent rail renders only when the daemon
  // reports the surface is enabled (JINN_ENABLE_EMBEDDED_AGENT=1). Default-off.
  // Read via the same `window.__JINN_FEATURES__` channel as every other flag.
  const { pluginBuilderUi, embeddedAgent } = getFeatures();

  return (
    <Router>
      <OfflineBanner connection={connection} />
      <RestartBanner
        restartPending={restartPending}
        onRestart={async () => {
          await api.restartDaemon();
          setRestartPending(false);
        }}
      />
      <AppShell
        header={<Header network={network} rpcHealthy={true} masterAddress={masterAddress} />}
        tabs={<TopTabs />}
        rail={embeddedAgent ? <AgentRail /> : undefined}
      >
        <Switch>
          <Route path="/overview/activity"><OverviewActivityPage /></Route>
          <Route path="/overview" component={OverviewPage} />
          <Route path="/operator/join/:cid"><JoinFlow /></Route>
          <Route path="/operator/execution-data"><CapturesTab /></Route>
          <Route path="/operator">
            <OperatorPage onRestartPending={() => setRestartPending(true)} />
          </Route>
          <Route path="/captures"><Redirect to="/operator/execution-data" /></Route>
          <Route path="/configuration"><ConfigurationRedirect /></Route>
          <Route path="/launcher/create"><LauncherCreatePage /></Route>
          <Route path="/launcher/launched/:solverNetId">
            <LauncherLaunchedPage />
          </Route>
          <Route path="/launcher"><LauncherPage /></Route>
          <Route path="/build">
            {pluginBuilderUi ? <BuildPage /> : <Redirect to="/overview" />}
          </Route>
          <Route><Redirect to="/overview" /></Route>
        </Switch>
      </AppShell>
    </Router>
  );
}

function ConfigurationRedirect(): JSX.Element {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  return <Redirect to={`/operator${hash}`} />;
}
