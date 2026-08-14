import { useQuery } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { Router, Route, Switch, Redirect } from 'wouter';
import { api } from './api/client.js';
import type { BootstrapState } from './../../../api/contract/index.js';
import { useConnectionState } from './api/connection-state.js';
import { LoadingScreen } from './regions/LoadingScreen.js';
import { Onboarding } from './regions/Onboarding.js';
import { DaemonOfflineScreen } from './regions/DaemonOfflineScreen.js';
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
import { CapturesTab } from './captures/CapturesTab.js';
import { OperatorShell } from './pages/operator/OperatorShell.js';
import { ClaimPolicyTab } from './pages/operator/ClaimPolicyTab.js';
import { MembershipsTab } from './pages/operator/MembershipsTab.js';
import { RegistryTab } from './pages/operator/RegistryTab.js';
import { NetworkTab } from './pages/operator/NetworkTab.js';
import { SecurityTab } from './pages/operator/SecurityTab.js';
import { BuildPage } from './pages/Build.js';
import { getFeatures } from './lib/features.js';
import { OfflineNotice } from './notifications/components/OfflineNotice.js';
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
  const connection = useConnectionState();
  const [restartPending, setRestartPending] = useState(false);

  // Offline state and restart-pending are both notification categories (§2.10).
  // They flow through useNotifications / AppShell's NotificationsList instead
  // of standalone banners. RestartPendingContext makes the flag available to
  // useNotifications without prop-drilling.
  const restartCtx = { restartPending, setRestartPending };

  // Three-way pre-running gate (issue #110):
  //
  //   1. Daemon offline — connection is disconnected AND we have no cached data.
  //      Show DaemonOfflineScreen with recovery instruction ("jinn run").
  //
  //   2. Bootstrap in progress — we have data but mode is not 'running'.
  //      Show Onboarding (covers 'setup' AND 'uninitialized' so the operator
  //      sees funding/error cards rather than a blank loading state).
  //
  //   3. Loading — we are connected but data hasn't arrived yet.
  //      Show the "Starting jinn" LoadingScreen.
  //
  // The original `data.mode === 'uninitialized' → LoadingScreen` path is
  // removed: uninitialized now always routes to Onboarding (branch 2), which
  // can render actionable error/funding cards from the enriched API response.
  if (connection.status === 'disconnected' && !data) {
    // TypeScript narrows `connection` to the disconnected variant here, which
    // satisfies DaemonOfflineScreen's tightened prop type.
    return (
      <TooltipProvider delayDuration={150}>
        <DaemonOfflineScreen connection={connection} />
        <Toaster />
      </TooltipProvider>
    );
  }

  // #983: keep the onboarding takeover until the operator finishes the guided
  // flow. The daemon flips mode→running on the earning state machine alone; a
  // node that finished bootstrap but has not completed onboarding (joined ≥1
  // SolverNet AND readied a solver harness AND selected a model) is not yet
  // usable. The first join populates joinedSolverNets mid-flow, so gating on
  // that map ejected the operator before the harness step (#983 MEDIUM). We
  // gate instead on an explicit completion flag the daemon surfaces from its
  // in-memory config, set by POST /v1/operator/onboarding-complete when the
  // operator clicks "Enter dashboard". The harness-ready and model-selected
  // legs are enforced inside <Onboarding>'s own Enter-dashboard gate.
  const onboardingComplete = data?.onboardingComplete === true;
  if (data && (data.mode !== 'running' || !onboardingComplete)) {
    return (
      <TooltipProvider delayDuration={150}>
        <OfflineNotice />
        <Onboarding />
        <Toaster />
      </TooltipProvider>
    );
  }

  if (isLoading || !data) {
    return (
      <TooltipProvider delayDuration={150}>
        <LoadingScreen headline="Starting jinn" />
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
              <Route path="/operator/execution-data">
                <OperatorShell>
                  <CapturesTab />
                </OperatorShell>
              </Route>
              <Route path="/operator/claim-policy">
                <OperatorShell>
                  <ClaimPolicyTab onRestartPending={() => setRestartPending(true)} />
                </OperatorShell>
              </Route>
              {/* Read-only after Wave-4 D1 — OPERATOR-APP-SPEC §2.4 keeps
                  Memberships as the legacy view until cutover stage 5, so it
                  takes no `onRestartPending` (there is nothing to write). */}
              <Route path="/operator/memberships">
                <OperatorShell>
                  <MembershipsTab />
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
              <Route path="/operator"><Redirect to="/operator/claim-policy" /></Route>
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
