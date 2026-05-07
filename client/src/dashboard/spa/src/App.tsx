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
import { ConfigurationPage } from './pages/Configuration.js';
import { LeaderboardPage } from './pages/leaderboard/Leaderboard.js';

/**
 * App routes between two distinct phases of operator life:
 *
 *   Onboarding — bootstrap not yet 'running'. A focused, full-screen flow.
 *
 *   Operating  — bootstrap complete. A persistent shell (header, top tabs,
 *                agent rail) wraps two routed pages: /overview and
 *                /configuration. The operator's relationship with the agent
 *                stays continuous across both pages.
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
          <Route path="/overview" component={OverviewPage} />
          <Route path="/configuration">
            <ConfigurationPage onRestartPending={() => setRestartPending(true)} />
          </Route>
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
