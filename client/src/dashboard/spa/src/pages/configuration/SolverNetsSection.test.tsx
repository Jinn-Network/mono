import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SolverNetsSection } from './SolverNetsSection.js';

/**
 * SolverNetsSection now wraps only the RegistryCatalog (DISCOVER block).
 * The JOINED block was extracted to pages/operator/MembershipsTab.tsx (Task 5.3).
 * This file will be deleted in Task 5.4 along with SolverNetsSection once
 * RegistryTab is extracted.
 */

vi.mock('../../api/client.js', () => ({
  api: {
    getSolverNets: vi.fn(),
    operator: {
      listJoined: async () => ({ joinedSolverNets: {} }),
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
});
