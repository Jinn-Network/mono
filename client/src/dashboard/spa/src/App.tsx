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
import { RestartBanner } from './shell/RestartBanner.js';
import { OverviewPage } from './pages/Overview.js';
import { OverviewActivityPage } from './pages/OverviewActivity.js';
import { LeaderboardPage } from './pages/leaderboard/Leaderboard.js';
import { OperatorPage } from './pages/Operator.js';
import { LauncherPage } from './pages/Launcher.js';
import { LauncherCreatePage } from './pages/LauncherCreate.js';
import { LauncherLaunchedPage } from './pages/LauncherLaunched.js';
import { JoinFlow } from './pages/operator-catalog/JoinFlow.js';

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

  return (
    <Router>
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
        rail={<AgentRail />}
      >
        <Switch>
          <Route path="/overview/activity"><OverviewActivityPage /></Route>
          <Route path="/overview" component={OverviewPage} />
          <Route path="/operator/join/:cid"><JoinFlow /></Route>
          <Route path="/operator">
            <OperatorPage onRestartPending={() => setRestartPending(true)} />
          </Route>
          <Route path="/configuration"><ConfigurationRedirect /></Route>
          <Route path="/launcher/create"><LauncherCreatePage /></Route>
          <Route path="/launcher/launched/:solverNetId">
            <LauncherLaunchedPage />
          </Route>
          <Route path="/launcher"><LauncherPage /></Route>
          <Route path="/leaderboard/:solverNet">
            {(params: { solverNet: string }) => (
              <LeaderboardPage solverNet={params.solverNet} />
            )}
          </Route>
          <Route path="/leaderboard">
            <Redirect to="/leaderboard/prediction" />
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
