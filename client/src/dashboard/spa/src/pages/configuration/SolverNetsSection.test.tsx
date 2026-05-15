import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SolverNetsSection } from './SolverNetsSection.js';
import { api } from '../../api/client.js';

/**
 * SolverNetsSection now has two sub-blocks: Joined (operator's joined
 * SolverNets, edit-in-place via JoinedNetCard) above the discovery
 * RegistryCatalog. Tests cover both blocks rendering and the joined-block
 * empty state.
 */

vi.mock('../../api/client.js', () => ({
  api: {
    getSolverNets: vi.fn(),
    operator: {
      listJoined: vi.fn(),
      join: vi.fn(),
    },
    solvernets: {
      listRegistry: async () => ({
        summaries: [
          {
            manifestCid: 'bafybeiaaa',
            solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
            name: 'Prediction Markets',
            network: 'base-sepolia',
            launcherAgentId: '5474',
            launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
            status: 'launched',
            statusUpdatedAt: '2026-05-05T00:00:00Z',
            contractId: 'prediction',
            contractVersion: 'v1',
            solutionPriceWei: '1000000000000000',
            verdictPriceWei: '500000000000000',
            openRoles: ['solver', 'evaluator'],
            anchorBlock: 1,
          },
        ],
        lastRefreshedAt: '2026-05-05T01:00:00Z',
        lastError: null,
      }),
    },
  },
}));

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/operator' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSolverNets).mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '2026-05-07T00:00:00Z',
    nets: [],
  });
  vi.mocked(api.operator.listJoined).mockResolvedValue({ joinedSolverNets: {} });
});

afterEach(() => {
  window.location.hash = '';
  cleanup();
});

describe('SolverNetsSection', () => {
  it('renders the SectionCard wrapping the RegistryCatalog', async () => {
    render(withProviders(<SolverNetsSection />));
    expect(screen.getByText(/^solvernets$/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Prediction Markets')).toBeTruthy(),
    );
    expect(screen.getByTestId('registry-join-cta').getAttribute('href')).toBe(
      '/operator/join/bafybeiaaa',
    );
  });

  it('renders the Joined block with empty state when no SolverNets are joined', async () => {
    render(withProviders(<SolverNetsSection />));
    await waitFor(() =>
      expect(screen.getByTestId('solvernets-joined-empty')).toBeTruthy(),
    );
    expect(screen.getByText(/Joined · 0/i)).toBeTruthy();
  });

  it('anchors and focuses the SolverNets section for /operator#solvernets', async () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    HTMLElement.prototype.focus = focus;
    window.location.hash = '';

    try {
      render(withProviders(<SolverNetsSection />));
      expect(scrollIntoView).not.toHaveBeenCalled();
      window.location.hash = '#solvernets';
      window.dispatchEvent(new Event('hashchange'));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' }));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.getElementById('solvernets')?.getAttribute('tabindex')).toBe('-1');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      HTMLElement.prototype.focus = originalFocus;
    }
  });

  it('renders one JoinedNetCard per joined SolverNet', async () => {
    vi.mocked(api.operator.listJoined).mockResolvedValue({
      joinedSolverNets: {
        bafybeiaaa: {
          manifestCid: 'bafybeiaaa',
          name: 'Prediction Markets',
          roles: ['solver'],
          harness: 'claude-code-learner',
          plugins: [],
          model: 'claude-haiku-4-5-20251001',
        },
        bafybeibbb: {
          manifestCid: 'bafybeibbb',
          name: 'Other Net',
          roles: ['evaluator'],
          harness: 'legacy-claude',
          plugins: ['plug-1'],
          model: 'claude-opus-4-7',
        },
      },
    });
    render(withProviders(<SolverNetsSection />));
    await waitFor(() =>
      expect(screen.getAllByTestId('joined-net-card')).toHaveLength(2),
    );
    expect(screen.getByText(/Joined · 2/i)).toBeTruthy();
    // Joined cards are keyed by manifest cid; Discover filters joined
    // manifests out of the catalog.
    const cards = screen.getAllByTestId('joined-net-card');
    expect(cards.find((c) => c.getAttribute('data-manifest-cid') === 'bafybeiaaa')).toBeTruthy();
    expect(cards.find((c) => c.getAttribute('data-manifest-cid') === 'bafybeibbb')).toBeTruthy();
    expect(screen.getByText('Other Net')).toBeTruthy();
  });

  it('auto-expands the joined card whose cid matches joinedHashFragment', async () => {
    vi.mocked(api.operator.listJoined).mockResolvedValue({
      joinedSolverNets: {
        bafybeiaaa: {
          manifestCid: 'bafybeiaaa',
          name: 'Prediction Markets',
          roles: ['solver'],
          harness: 'claude-code-learner',
          plugins: [],
          model: 'claude-haiku-4-5-20251001',
        },
        bafybeibbb: {
          manifestCid: 'bafybeibbb',
          name: 'Other Net',
          roles: ['evaluator'],
          harness: 'legacy-claude',
          plugins: [],
          model: 'claude-opus-4-7',
        },
      },
    });
    render(
      withProviders(
        <SolverNetsSection joinedHashFragment="bafybeibbb/harness" />,
      ),
    );
    await waitFor(() => {
      const cards = screen.getAllByTestId('joined-net-card');
      expect(cards).toHaveLength(2);
    });
    const targetCard = screen
      .getAllByTestId('joined-net-card')
      .find((el) => el.getAttribute('data-manifest-cid') === 'bafybeibbb');
    expect(targetCard?.getAttribute('data-expanded')).toBe('true');
    const otherCard = screen
      .getAllByTestId('joined-net-card')
      .find((el) => el.getAttribute('data-manifest-cid') === 'bafybeiaaa');
    expect(otherCard?.getAttribute('data-expanded')).toBe('false');
  });
});
