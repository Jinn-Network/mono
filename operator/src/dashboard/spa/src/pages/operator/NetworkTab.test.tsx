import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkTab } from './NetworkTab.js';
import { api } from '../../api/client.js';

import type { JSX } from 'react';

vi.mock('../../api/client.js', () => ({
  api: {
    getBootstrap: vi.fn(async () => ({
      chain: 'base-sepolia',
      rpcUrl: 'https://my-alchemy.example/key',
      defaultRpcUrl: 'https://base-sepolia.publicnode.com',
      rpcUrls: [
        'https://my-alchemy.example/key',
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
      publicDefaults: [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
      rpcSlotHealth: [
        {
          ok: true,
          host: 'my-alchemy.example',
          latencyMs: 12,
          expectedChainId: 84532,
          actualChainId: 84532,
        },
        {
          ok: false,
          host: 'base-sepolia.publicnode.com',
          reason: 'chain_mismatch',
          expectedChainId: 84532,
          actualChainId: 8453,
        },
        { ok: false, host: 'sepolia.base.org', code: 429 },
      ],
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

  it('renders the chain locked chip', async () => {
    render(withProviders(<NetworkTab />));
    await waitFor(() => expect(screen.getByText(/locked/i)).toBeTruthy());
  });

  it('renders one ordered read-only row per slot with masked host + health (AC1/AC4)', async () => {
    render(withProviders(<NetworkTab />));
    await screen.findByTestId('network-rpc-slots');
    await waitFor(() =>
      expect(
        screen
          .getByTestId('network-rpc-slots')
          .querySelectorAll('[data-testid="network-rpc-slot"]'),
      ).toHaveLength(3),
    );
    const rows = screen
      .getByTestId('network-rpc-slots')
      .querySelectorAll('[data-testid="network-rpc-slot"]');
    // Ordered by slot index; hosts are masked (no path / key segment).
    expect(rows[0]!.textContent).toMatch(/my-alchemy\.example/);
    expect(rows[0]!.textContent).not.toMatch(/\/key/);
    expect(rows[1]!.textContent).toMatch(/base-sepolia\.publicnode\.com/);
    expect(rows[2]!.textContent).toMatch(/sepolia\.base\.org/);
    // A reachable wrong-chain slot is not healthy.
    expect(rows[1]!.textContent).toMatch(/wrong chain/i);
    expect(rows[1]!.textContent).not.toMatch(/healthy/i);
    // The 429 slot renders a degraded badge.
    expect(rows[2]!.textContent).toMatch(/429|unhealthy|degraded/i);
  });

  it('shows the Primary RPC input prefilled with the current primary (AC2)', async () => {
    render(withProviders(<NetworkTab />));
    await screen.findByLabelText(/primary rpc/i);
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/primary rpc/i) as HTMLInputElement).value,
      ).toBe('https://my-alchemy.example/key'),
    );
  });

  it('renders the "tried first — falls back to public chain on failure" copy (AC4)', async () => {
    render(withProviders(<NetworkTab />));
    await waitFor(() =>
      expect(screen.getByTestId('network-tab').textContent).toMatch(
        /tried first.*falls back to public chain on failure/i,
      ),
    );
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
