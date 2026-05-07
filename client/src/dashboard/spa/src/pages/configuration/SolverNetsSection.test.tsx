import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SolverNetsSection } from './SolverNetsSection.js';

/**
 * SolverNetsSection now wraps the registry-driven RegistryCatalog. The
 * legacy hardcoded "prediction" entry from `/v1/setup/solvernets` is gone;
 * the section is empty until the daemon's registry surface returns launched
 * SolverNets.
 */

vi.mock('../../api/client.js', () => ({
  api: {
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

describe('SolverNetsSection', () => {
  it('renders the SectionCard wrapping the RegistryCatalog', async () => {
    render(withProviders(<SolverNetsSection />));
    // SectionCard heading anchors the section regardless of catalog state.
    expect(screen.getByText(/^solvernets$/i)).toBeTruthy();
    // Registry card surfaces the launched summary's name + Join CTA.
    await waitFor(() =>
      expect(screen.getByText('Prediction Markets')).toBeTruthy(),
    );
    expect(screen.getByTestId('registry-join-cta').getAttribute('href')).toBe(
      '/operator/join/bafybeiaaa',
    );
  });
});
