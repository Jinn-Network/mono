import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkTab } from './NetworkTab.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getBootstrap: vi.fn(async () => ({
      chain: 'base-sepolia',
      rpcUrl: 'https://my-tenderly.example/abc',
      defaultRpcUrl: 'https://sepolia.base.org',
    })),
    updateNetwork: vi.fn(async () => ({ restartRequired: true })),
    discovery: {
      getTaskPostCounts: vi.fn(async () => ({
        windowEndBlock: 1000,
        windowEndTs: 1715600000,
        chain: { h1: 2, h6: 5, h24: 11, windowEndBlock: 1000, windowEndTs: 1715600000 },
        byCid: {},
      })),
    },
  },
}));

function withProviders(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(api.discovery.getTaskPostCounts).mockResolvedValue({
    windowEndBlock: 1000,
    windowEndTs: 1715600000,
    chain: { h1: 2, h6: 5, h24: 11, windowEndBlock: 1000, windowEndTs: 1715600000 },
    byCid: {},
  });
});

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

describe('NetworkTab — Task posts panel (#918)', () => {
  it('renders the three windowed counts from data.chain', async () => {
    render(withProviders(<NetworkTab />));
    await waitFor(() => {
      const panel = screen.getByTestId('network-task-posts');
      expect(panel.textContent).toMatch(/Last 24h/i);
      expect(panel.textContent).toMatch(/11/);  // h24
    });
    const panel = screen.getByTestId('network-task-posts');
    expect(panel.textContent).toMatch(/2/);   // h1
    expect(panel.textContent).toMatch(/5/);   // h6
  });

  it('renders a visible zero-state message when h24 is 0 (AC#3)', async () => {
    vi.mocked(api.discovery.getTaskPostCounts).mockResolvedValue({
      windowEndBlock: 1000,
      windowEndTs: 1715600000,
      chain: { h1: 0, h6: 0, h24: 0, windowEndBlock: 1000, windowEndTs: 1715600000 },
      byCid: {},
    });
    render(withProviders(<NetworkTab />));
    await waitFor(() => {
      const panel = screen.getByTestId('network-task-posts');
      expect(panel.textContent).toMatch(/No task posts in the last 24h/i);
    });
  });

  it('renders an unavailable message on a discovery_unavailable error', async () => {
    const err = new Error('discovery_unavailable') as Error & { code?: string };
    err.code = 'discovery_unavailable';
    vi.mocked(api.discovery.getTaskPostCounts).mockRejectedValue(err);
    render(withProviders(<NetworkTab />));
    await waitFor(() => {
      const panel = screen.getByTestId('network-task-posts');
      expect(panel.textContent).toMatch(/unavailable while the indexer catches up/i);
    });
  });

  it('renders the rate-limited warning on an rpc_rate_limited error', async () => {
    const err = new Error('rpc_rate_limited') as Error & { code?: string };
    err.code = 'rpc_rate_limited';
    vi.mocked(api.discovery.getTaskPostCounts).mockRejectedValue(err);
    render(withProviders(<NetworkTab />));
    await waitFor(() => {
      const alert = screen.getByTestId('network-task-posts').querySelector(
        '[data-error-code="rpc_rate_limited"]',
      );
      expect(alert).toBeTruthy();
      expect(alert?.textContent).toMatch(/RPC rate-limited/i);
      expect(alert?.textContent).toMatch(/add your own free key/i);
    });
  });
});
