import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkTab } from './NetworkTab.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getBootstrap: async () => ({
      chain: 'base-sepolia',
      rpcUrl: 'https://my-tenderly.example/abc',
      defaultRpcUrl: 'https://sepolia.base.org',
    }),
    updateNetwork: async () => ({ restartRequired: true }),
  },
}));

function withProviders(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('NetworkTab', () => {
  it('renders the network-tab container', () => {
    render(withProviders(<NetworkTab />));
    expect(screen.getByTestId('network-tab')).toBeTruthy();
  });

  it('renders the Network section heading', () => {
    render(withProviders(<NetworkTab />));
    // shadcn Card.CardTitle exposes the heading as an <h3>.
    const heading = screen.getByRole('heading', { name: /^network$/i });
    expect(heading).toBeTruthy();
  });

  it('renders the chain locked chip + RPC URL input', () => {
    render(withProviders(<NetworkTab />));
    expect(screen.getByText(/locked/i)).toBeTruthy();
    expect(screen.getByLabelText(/rpc url/i)).toBeTruthy();
  });
});
