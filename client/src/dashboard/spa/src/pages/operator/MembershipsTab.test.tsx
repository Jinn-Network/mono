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
    },
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
    await waitFor(() => expect(screen.getByText(/Joined · 0/i)).toBeTruthy());
  });

  it('empty state names the config file that fills it', async () => {
    render(withProviders(<MembershipsTab />));
    await waitFor(() => expect(screen.getByTestId('memberships-tab-empty')).toBeTruthy());
    expect(screen.getByTestId('memberships-tab-empty').textContent).toMatch(
      /joinedSolverNets/,
    );
    expect(screen.getByTestId('memberships-tab-empty').textContent).toMatch(
      /config\.json/,
    );
  });

  it('renders one read-only row per joined SolverNet', async () => {
    vi.mocked(api.operator.listJoined).mockResolvedValue({
      joinedSolverNets: {
        bafybeiaaa: {
          manifestCid: 'bafybeiaaa',
          name: 'Prediction Markets',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'claude-code-learner',
          plugins: ['jinn-prediction-plugin'],
          model: 'claude-haiku-4-5-20251001',
        },
      },
    });
    render(withProviders(<MembershipsTab />));
    await waitFor(() => expect(screen.getAllByTestId('joined-net-card')).toHaveLength(1));
    expect(screen.getByText(/Joined · 1/i)).toBeTruthy();
    expect(screen.getByTestId('joined-net-card-name').textContent).toBe('Prediction Markets');
    expect(screen.getByTestId('joined-net-card-role-solver')).toBeTruthy();
    expect(screen.getByText('claude-haiku-4-5-20251001')).toBeTruthy();
  });

  /**
   * The point of the fix round: this page is a VIEW. Wave-4 D1 deleted the
   * join/leave routes, so any control that would have written config here is a
   * dead end. Pin their absence rather than trusting the component not to
   * regrow them.
   */
  it('exposes no edit, save, or leave control', async () => {
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
    await waitFor(() => expect(screen.getAllByTestId('joined-net-card')).toHaveLength(1));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByTestId('joined-net-card-save')).toBeNull();
    expect(screen.queryByTestId('joined-net-card-leave')).toBeNull();
    expect(screen.queryByTestId('joined-net-card-toggle')).toBeNull();
  });
});
