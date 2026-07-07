import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { App } from './App';

// Minimal network fixture so the useNetwork() hook resolves cleanly
const NETWORK_FIXTURE = {
  tasksPosted: 10,
  tasksSettled: 8,
  tasksRefunded: 0,
  attempts: 25,
  everAttemptedOperators: 3,
  solverNetsRunning: 2,
  verdicts: 20,
  verdictsPass: 16,
  resolvedRate: 0.8,
  mostRecentSettlementBlock: null,
  composition: { byMode: [], byHarness: [], byModel: [], byPlugin: [] },
  enrichmentCoverage: { enrichedAttempts: 20, totalAttempts: 25, share: 0.8 },
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const OPERATORS_FIXTURE = {
  ranked: [],
  lowVolume: [],
  minVerdicts: 5,
  activeOperators: 0,
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

function makeWrapper(path = '/') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }

  return { Wrapper, qc };
}

describe('App', () => {
  beforeEach(() => {
    // Mock fetch so hooks don't make real network requests
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/explorer/network')) {
        return Promise.resolve(
          new Response(JSON.stringify(NETWORK_FIXTURE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (urlStr.includes('/explorer/operators')) {
        return Promise.resolve(
          new Response(JSON.stringify(OPERATORS_FIXTURE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Chrome header', () => {
    const { Wrapper } = makeWrapper('/');
    render(<App />, { wrapper: Wrapper });
    // Logo wordmark
    expect(screen.getByText('jinn')).toBeInTheDocument();
    // Corpus leads the nav (Network is the logo's job now)
    expect(screen.getAllByText('Corpus').length).toBeGreaterThan(0);
  });

  it('renders the Dashboard at "/"', async () => {
    const { Wrapper } = makeWrapper('/');
    render(<App />, { wrapper: Wrapper });
    // The dashboard's Activity strip lands once the network hook resolves.
    await waitFor(() => expect(screen.getByText(/active operators/i)).toBeInTheDocument());
  });

  it('renders OperatorsView stub at "/operators"', () => {
    const { Wrapper } = makeWrapper('/operators');
    render(<App />, { wrapper: Wrapper });
    // "Operators" appears in nav and view heading — both are expected
    expect(screen.getAllByText('Operators').length).toBeGreaterThan(0);
  });

  it('renders SolverNetsListView stub at "/solvernets"', () => {
    const { Wrapper } = makeWrapper('/solvernets');
    render(<App />, { wrapper: Wrapper });
    // "SolverNets" appears in both the nav and the view heading — that's expected
    expect(screen.getAllByText('SolverNets').length).toBeGreaterThan(0);
  });

  it('renders 404 for unknown routes', () => {
    const { Wrapper } = makeWrapper('/unknown-path');
    render(<App />, { wrapper: Wrapper });
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('marks no nav item active on the Dashboard "/" (the logo is home)', () => {
    const { Wrapper } = makeWrapper('/');
    render(<App />, { wrapper: Wrapper });
    // No nav item owns "/", so none is aria-current there.
    const active = screen
      .getAllByText(/Corpus|SolverNets|Operators/)
      .filter((el) => el.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(0);
  });

  it('marks the correct nav item active for "/operators"', () => {
    const { Wrapper } = makeWrapper('/operators');
    render(<App />, { wrapper: Wrapper });
    // Find the nav link (a element) with aria-current
    const operatorsLinks = screen.getAllByText('Operators');
    const navLink = operatorsLinks.find(
      (el) => el.getAttribute('aria-current') === 'page',
    );
    expect(navLink).toBeTruthy();
  });
});
