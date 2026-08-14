import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RegistryTab } from './RegistryTab.js';

import type { JSX } from 'react';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
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
  const { hook } = memoryLocation({ path: '/operator/registry' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

describe('RegistryTab', () => {
  it('renders the Discover heading and the RegistryCatalog', async () => {
    render(withProviders(<RegistryTab />));
    expect(screen.getByText(/discover/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Prediction Markets')).toBeTruthy(),
    );
  });

  it('renders the registry-tab container', () => {
    render(withProviders(<RegistryTab />));
    expect(screen.getByTestId('registry-tab')).toBeTruthy();
  });
});
