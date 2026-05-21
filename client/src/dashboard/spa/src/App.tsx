import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Router, Route, Switch, Redirect } from 'wouter';
import { api } from './api/client.js';
import type { BootstrapState } from './api/types.js';
import { LoadingScreen } from './regions/LoadingScreen.js';
import { Onboarding } from './regions/Onboarding.js';
import { AppShell } from './shell/AppShell.js';
import { Header } from './shell/Header.js';
import { TopTabs } from './shell/TopTabs.js';
import { AgentRail } from './shell/AgentRail.js';
import { RestartPendingContext } from './shell/RestartPendingContext.js';
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

  // Offline state and restart-pending are both notification categories (§2.10).
  // They flow through useNotifications / AppShell's NotificationsList instead
  // of standalone banners. RestartPendingContext makes the flag available to
  // useNotifications without prop-drilling.
  const restartCtx = { restartPending, setRestartPending };

  if (isLoading || !data || data.mode === 'uninitialized') {
    const headline = !data
      ? 'Starting jinn'
      : data.mode === 'uninitialized'
        ? 'Setting up your wallet'
        : 'Loading';
    return <LoadingScreen headline={headline} />;
  }

  if (data.mode !== 'running') {
    return <Onboarding />;
  }

  const network = (data.chain === 'base' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet';
  const masterAddress = data.master_address ?? '';
  // Issue #326: the embedded agent rail renders only when the daemon reports
  // the surface is enabled (JINN_ENABLE_EMBEDDED_AGENT=1). Default-off.
  const embeddedAgentEnabled = data.embeddedAgentEnabled === true;

  // Issue #327: the builder surfaces (/build route + Build top-tab) are hidden
  // until the operator-app first-run UX is solid. The plug-in substrate stays
  // live for direct-CLI builders; only the operator-app promotion is gated.
  // Set JINN_ENABLE_PLUGIN_BUILDER_UI=1 on the daemon to re-enable.
  const pluginBuilderUi = getFeatures().pluginBuilderUi;

  return (
    <RestartPendingContext.Provider value={restartCtx}>
      <Router>
        <AppShell
          header={<Header network={network} rpcHealthy={true} masterAddress={masterAddress} />}
          tabs={<TopTabs />}
          rail={embeddedAgentEnabled ? <AgentRail /> : undefined}
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
    </RestartPendingContext.Provider>
  );
}

function ConfigurationRedirect(): JSX.Element {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  return <Redirect to={`/operator${hash}`} />;
}
