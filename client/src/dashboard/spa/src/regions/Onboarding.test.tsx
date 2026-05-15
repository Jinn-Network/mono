import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding } from './Onboarding.js';
import type { BootstrapState } from '../api/types.js';

// Mock the API client so we control what bootstrap + status data returns.
vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: async (): Promise<BootstrapState> => ({
      schemaVersion: 1,
      mode: 'bootstrap',
      steps: ['wallet', 'safe_predicted', 'awaiting_funding'],
      currentStep: 'wallet',
      services: [],
      chain: 'base-sepolia',
    }),
  },
}));

function withQueryClient(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('Onboarding (3-phase post-vh74.2)', () => {
  it('renders exactly three phases', async () => {
    render(withQueryClient(<Onboarding />));

    // Wait for bootstrap data to load (queries are async)
    await screen.findByText(/Provisioning your wallet/i);

    expect(screen.getByText(/Provisioning your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Fund your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Joining Jinn/i)).toBeTruthy();
    expect(screen.queryByText(/Sign in to Claude/i)).toBeNull();
  });

  it('does not render a Sign in to Claude phase', async () => {
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.queryByText(/Sign in to Claude/i)).toBeNull();
  });
});
