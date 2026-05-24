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
import { EventsPage } from './pages/Events.js';
import { EventDetailPage } from './pages/EventDetail.js';
import { LauncherPage } from './pages/Launcher.js';
import { LauncherCreatePage } from './pages/LauncherCreate.js';
import { LauncherLaunchedPage } from './pages/LauncherLaunched.js';
import { JoinFlow } from './pages/operator-catalog/JoinFlow.js';
import { CapturesTab } from './captures/CapturesTab.js';
import { OperatorShell } from './pages/operator/OperatorShell.js';
import { MembershipsTab } from './pages/operator/MembershipsTab.js';
import { RegistryTab } from './pages/operator/RegistryTab.js';
import { NetworkTab } from './pages/operator/NetworkTab.js';
import { SecurityTab } from './pages/operator/SecurityTab.js';
import { BuildPage } from './pages/Build.js';
import { getFeatures } from './lib/features.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { Toaster } from './components/ui/sonner.js';

/**
 * App routes between two distinct phases of operator life:
 *
 *   Onboarding — bootstrap not yet 'running'. A focused, full-screen flow.
 *
 *   Operating  — bootstrap complete. A persistent shell (header, top tabs,
 *                agent rail) wraps top-level workspaces: /overview,
 *                /operator, and /launcher.
 *
 * `TooltipProvider` and `Toaster` are mounted at the root so descendants
 * can use shadcn `<Tooltip>` / sonner `toast()` without re-declaring the
 * provider in every card.
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
    return (
      <TooltipProvider delayDuration={150}>
        <LoadingScreen headline={headline} />
        <Toaster />
      </TooltipProvider>
    );
  }

  if (data.mode !== 'running') {
    return (
      <TooltipProvider delayDuration={150}>
        <Onboarding />
        <Toaster />
      </TooltipProvider>
    );
  }

  const network = (data.chain === 'base' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet';

  const { pluginBuilderUi, embeddedAgent } = getFeatures();

  return (
    <TooltipProvider delayDuration={150}>
      <RestartPendingContext.Provider value={restartCtx}>
        <Router>
          <AppShell
            header={<Header network={network} />}
            tabs={<TopTabs />}
            rail={embeddedAgent ? <AgentRail /> : undefined}
          >
            <Switch>
              <Route path="/events/:id"><EventDetailPage /></Route>
              <Route path="/events"><EventsPage /></Route>
              <Route path="/overview" component={OverviewPage} />
              <Route path="/operator/join/:cid"><JoinFlow /></Route>
              <Route path="/operator/execution-data">
                <OperatorShell>
                  <CapturesTab />
                </OperatorShell>
              </Route>
              <Route path="/operator/memberships">
                <OperatorShell>
                  <MembershipsTab onRestartPending={() => setRestartPending(true)} />
                </OperatorShell>
              </Route>
              <Route path="/operator/registry">
                <OperatorShell>
                  <RegistryTab />
                </OperatorShell>
              </Route>
              <Route path="/operator/network">
                <OperatorShell>
                  <NetworkTab onRestartPending={() => setRestartPending(true)} />
                </OperatorShell>
              </Route>
              <Route path="/operator/security">
                <OperatorShell>
                  <SecurityTab />
                </OperatorShell>
              </Route>
              <Route path="/operator"><Redirect to="/operator/memberships" /></Route>
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
        <Toaster />
      </RestartPendingContext.Provider>
    </TooltipProvider>
  );
}

function ConfigurationRedirect(): JSX.Element {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  return <Redirect to={`/operator${hash}`} />;
}
