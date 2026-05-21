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
    // The SectionCard button renders "Network" as the section title.
    const networkHeadings = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Network'));
    expect(networkHeadings.length).toBeGreaterThan(0);
  });

  it('renders the section body (defaultExpanded=true passes locked/rpc-url fields)', () => {
    render(withProviders(<NetworkTab />));
    // With defaultExpanded=true, SectionCard renders the body immediately.
    // The "locked" chip on the Chain field is a reliable stable assertion.
    expect(screen.getByText(/locked/i)).toBeTruthy();
  });
});
