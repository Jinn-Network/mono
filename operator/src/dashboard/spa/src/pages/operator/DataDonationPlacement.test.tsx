/**
 * Task 5.7 — Data Donation placement tests (§2.13).
 *
 * Asserts that the donation toggle is present on /operator/execution-data
 * (per spec §2.13: Data Donation belongs
 * with Artifact Serving, not with Memberships).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router, Route, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CapturesTab } from '../../captures/CapturesTab.js';

import type { JSX } from 'react';

const listArtifactsMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    captures: {
      listPending: async () => ({ captures: [] }),
      get: async () => ({}),
    },
    operator: {
      listArtifacts: (...args: unknown[]) => listArtifactsMock(...args),
      getClaimPolicy: async () => ({
        claimPolicy: { mode: 'match-legacy-manifest-digest' },
        executionWiring: [],
      }),
    },
    solvernets: {
      getManifest: vi.fn().mockRejectedValue(new Error('not found')),
    },
    getSolverNets: vi.fn().mockRejectedValue(new Error('no catalog')),
  },
}));

const servedResponse = {
  schemaVersion: 1,
  generatedAt: '2026-05-07T12:00:00.000Z',
  source: 'served',
  pricing: {
    publicEndpoint: 'https://op.example.com',
    defaultPriceUsdc: '0',
    perArtifactTypePrice: {},
    donation: { enabled: false },
  },
  summary: {
    served: {
      totalCount: 0,
      totalBytes: 0,
      freeCount: 0,
      gatedCount: 0,
      latestCreatedAt: null,
      artifactTypes: [],
    },
    network: {
      totalCount: 0,
      totalBytes: 0,
      latestFetchedAt: null,
      artifactTypes: [],
    },
    access: {
      accessCount: 0,
      paidServeCount: 0,
      freeServeCount: 0,
      failedPaymentCount: 0,
      paymentRequiredCount: 0,
      revenueUsdc: '0',
      lastAccessAt: null,
      lastPaidAt: null,
    },
  },
  recentAccesses: [],
  artifacts: [],
};

function withProviders(path: string, node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

describe('Data Donation placement (§2.13)', () => {
  it('renders the donation toggle on /operator/execution-data', async () => {
    listArtifactsMock.mockResolvedValue(servedResponse);
    render(
      withProviders(
        '/operator/execution-data',
        <Switch>
          <Route path="/operator/execution-data"><CapturesTab /></Route>
        </Switch>,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('operator-donation-toggle')).toBeTruthy(),
    );
  });

});
