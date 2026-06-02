import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MembershipsTab } from './MembershipsTab.js';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      listJoined: vi.fn(),
      join: vi.fn(),
      leave: vi.fn(),
    },
    solvernets: {
      getManifest: vi.fn().mockRejectedValue(new Error('not found')),
    },
    getSolverNets: vi.fn().mockRejectedValue(new Error('no catalog')),
  },
}));

import { api } from '../../api/client.js';

import type { JSX } from 'react';

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/operator/memberships' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.operator.listJoined).mockResolvedValue({ joinedSolverNets: {} });
});

describe('MembershipsTab', () => {
  it('renders the joined count header', async () => {
    render(withProviders(<MembershipsTab />));
    await waitFor(() =>
      expect(screen.getByText(/Joined · 0/i)).toBeTruthy(),
    );
  });

  it('shows empty state when no SolverNets are joined', async () => {
    render(withProviders(<MembershipsTab />));
    await waitFor(() =>
      expect(screen.getByTestId('memberships-tab-empty')).toBeTruthy(),
    );
    expect(screen.getByText(/browse the/i)).toBeTruthy();
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
      },
    });
    render(withProviders(<MembershipsTab />));
    await waitFor(() =>
      expect(screen.getAllByTestId('joined-net-card')).toHaveLength(1),
    );
    expect(screen.getByText(/Joined · 1/i)).toBeTruthy();
  });
});
