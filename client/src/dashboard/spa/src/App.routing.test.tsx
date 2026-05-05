import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router, Route, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OverviewPage } from './pages/Overview.js';
import { ConfigurationPage } from './pages/Configuration.js';

// Configuration + Overview pages both useQuery for the daemon API; mock so
// the routing tests don't depend on a live server.
vi.mock('./api/client.js', () => ({
  api: {
    getBootstrap: async () => ({}),
    getStatus: async () => ({}),
    getSolverNets: async () => ({ schemaVersion: 1, generatedAt: '', nets: [] }),
    claimRewards: async () => ({ ok: true }),
    restartDaemon: async () => ({ ok: true }),
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
          <Route path="/configuration"><ConfigurationPage /></Route>
        </Switch>,
        '/overview',
      ),
    );
    // Overview renders HeroStats with these canonical eyebrows.
    expect(screen.getByText(/tasks delivered/i)).toBeTruthy();
    expect(screen.getByText(/jinn earned/i)).toBeTruthy();
  });

  it('renders ConfigurationPage on /configuration', () => {
    render(
      withProviders(
        <Switch>
          <Route path="/overview"><OverviewPage /></Route>
          <Route path="/configuration"><ConfigurationPage /></Route>
        </Switch>,
        '/configuration',
      ),
    );
    // Configuration is composed of three section cards; the SolverNets head
    // is the most stable assertion since it never collapses to nothing.
    expect(screen.getByText(/solvernets/i)).toBeTruthy();
  });
});
