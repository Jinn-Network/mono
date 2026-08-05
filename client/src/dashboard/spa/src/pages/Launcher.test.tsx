import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { LauncherPage } from './Launcher.js';
import { api } from '../api/client.js';
import type {
  LaunchedSolverNetRecord,
  SolverNetManifestSummary,
} from '../../../../api/contract/index.js';

import type { JSX } from 'react';

vi.mock('../api/client.js', () => ({
  api: {
    solvernets: {
      listLaunched: vi.fn(),
    },
    discovery: {
      getTaskPostCounts: vi.fn(),
    },
  },
}));

function emptyPostCounts() {
  return {
    windowEndBlock: 0,
    windowEndTs: 0,
    chain: { h1: 0, h6: 0, h24: 0, windowEndBlock: 0, windowEndTs: 0 },
    byCid: {} as Record<string, { h1: number; h6: number; h24: number; windowEndBlock: number; windowEndTs: number }>,
  };
}

function buildRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    manifestCid: 'bafybeigdyrztxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    registry: {},
    ...overrides,
  };
}

function buildSummary(
  overrides: Partial<SolverNetManifestSummary> = {},
): SolverNetManifestSummary {
  return {
    manifestCid: 'bafybeigdyrztxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    name: 'Prediction Markets — V1',
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    contractId: 'prediction',
    contractVersion: 'v1',
    solutionPriceWei: '1000000000000000', // 0.001 ETH
    verdictPriceWei: '500000000000000', // 0.0005 ETH
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 200,
    ...overrides,
  };
}

function wrap(
  ui: JSX.Element,
  initialPath = '/launcher',
): { rendered: ReturnType<typeof render>; nav: ReturnType<typeof memoryLocation> } {
  const nav = memoryLocation({ path: initialPath, record: true });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={qc}>
      <Router hook={nav.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
  return { rendered, nav };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no posts. Tests that care override this.
  vi.mocked(api.discovery.getTaskPostCounts).mockResolvedValue(emptyPostCounts());
});

afterEach(() => {
  cleanup();
});

describe('LauncherPage', () => {
  it('renders loading state while the query is pending', () => {
    // Never-resolving promise keeps the query in `isLoading`.
    vi.mocked(api.solvernets.listLaunched).mockReturnValue(
      new Promise(() => undefined),
    );
    wrap(<LauncherPage />);
    expect(screen.getByTestId('launcher-loading')).toBeTruthy();
  });

  it('renders empty state with Create SolverNet CTA when no records exist', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({ records: [] });
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-empty-state')).toBeTruthy(),
    );
    expect(screen.getByText(/No SolverNets created yet\./i)).toBeTruthy();
    expect(
      screen.getByText(
        /Create a SolverNet to direct operators toward a specific kind of knowledge work\./i,
      ),
    ).toBeTruthy();
    const cta = screen.getByRole('link', { name: /Create SolverNet/i });
    expect(cta.getAttribute('href')).toBe('/launcher/create');
  });

  it('renders an error banner with retry when the query fails', async () => {
    vi.mocked(api.solvernets.listLaunched).mockRejectedValue(
      new Error('500 Internal Server Error'),
    );
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-error')).toBeTruthy(),
    );
    expect(screen.getByText(/Failed to load your SolverNets/i)).toBeTruthy();
    expect(screen.getByText(/500 Internal Server Error/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });

  it('renders a populated row with status badge, truncated cid, launchedAt (summary missing)', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({
          solverNetId: 'agent-1_prediction.v1-1_abcdef01',
          manifestCid: 'bafybeigdyrztxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          launchedAt: '2026-05-05T15:00:00Z',
          status: 'launched',
          // No summary — daemon's manifest cache missed (e.g. mid-launch
          // before the cache is warm). Page should fall back to the bare
          // record fields.
        }),
      ],
    });
    wrap(<LauncherPage />);
    const row = await screen.findByTestId('launcher-owned-row');
    expect(row.getAttribute('data-has-summary')).toBe('false');
    // Cache-miss fallback: solverNetId is the primary identifier.
    expect(within(row).getByText(/agent-1_prediction\.v1-1_abcdef01/)).toBeTruthy();
    // Status badge label is the title-cased exact-match "Launched".
    expect(within(row).getByText('Launched')).toBeTruthy();
    // Truncated cid: first 8 chars + ellipsis + last 6 chars.
    expect(within(row).getByText(/bafybeig…xxxxxx/i)).toBeTruthy();
    // launchedAt rendered as formatted UTC.
    expect(within(row).getByText(/2026-05-05 15:00 UTC/)).toBeTruthy();
    // No contract / prices / roles surfaces when summary is missing.
    expect(within(row).queryByTestId('launcher-owned-row-contract')).toBeNull();
    expect(within(row).queryByTestId('launcher-owned-row-prices')).toBeNull();
    expect(within(row).queryByTestId('launcher-owned-row-roles')).toBeNull();
  });

  it('renders manifest name, contract, prices, and openRoles when summary is present', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({
          solverNetId: 'agent-1_prediction.v1-1_abcdef01',
          summary: buildSummary({
            name: 'Prediction Markets — V1',
            contractId: 'prediction',
            contractVersion: 'v1',
            solutionPriceWei: '1000000000000000', // 0.001 ETH
            verdictPriceWei: '500000000000000', // 0.0005 ETH
            openRoles: ['solver', 'evaluator'],
          }),
        }),
      ],
    });
    wrap(<LauncherPage />);
    const row = await screen.findByTestId('launcher-owned-row');
    expect(row.getAttribute('data-has-summary')).toBe('true');
    // Primary identity = manifest name (not the bare solverNetId).
    const primary = within(row).getByTestId('launcher-owned-row-primary');
    expect(primary.textContent).toBe('Prediction Markets — V1');
    // Contract id.version chip.
    const contract = within(row).getByTestId('launcher-owned-row-contract');
    expect(contract.textContent).toBe('prediction.v1');
    // Prices block — solution + verdict, both formatted as ETH.
    const prices = within(row).getByTestId('launcher-owned-row-prices');
    expect(prices.textContent).toMatch(/solution\s+0\.001\s+ETH/);
    expect(prices.textContent).toMatch(/verdict\s+0\.0005\s+ETH/);
    // Open-roles chips.
    const roles = within(row).getByTestId('launcher-owned-row-roles');
    expect(within(roles).getByText('solver')).toBeTruthy();
    expect(within(roles).getByText('evaluator')).toBeTruthy();
    // The bare cid + launchedAt details still render alongside the summary
    // — they remain useful for debugging and click-through correlation.
    expect(within(row).getByText(/launched\s+2026-05-05 15:00 UTC/)).toBeTruthy();
  });

  it('formats tiny launched prices as gwei instead of scientific ETH notation', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({
          summary: buildSummary({
            name: 'SWE-rebench v2',
            contractId: 'swe-rebench-v2',
            contractVersion: 'v1',
            solutionPriceWei: '10000000000',
            verdictPriceWei: '5000000000',
          }),
        }),
      ],
    });
    wrap(<LauncherPage />);

    const row = await screen.findByTestId('launcher-owned-row');
    const prices = within(row).getByTestId('launcher-owned-row-prices');
    expect(prices.textContent).toMatch(/solution\s+10\s+gwei/);
    expect(prices.textContent).toMatch(/verdict\s+5\s+gwei/);
    expect(prices.textContent).not.toMatch(/e-\d+/i);
  });

  it('falls back to solverNetId when summary is missing on some rows but not others', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({
          solverNetId: 'net-with-summary',
          summary: buildSummary({ name: 'Has Summary' }),
        }),
        buildRecord({
          solverNetId: 'net-without-summary',
          // No summary.
        }),
      ],
    });
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-owned-row').length).toBe(2),
    );
    const rows = screen.getAllByTestId('launcher-owned-row');
    expect(
      within(rows[0]!).getByTestId('launcher-owned-row-primary').textContent,
    ).toBe('Has Summary');
    expect(rows[0]!.getAttribute('data-has-summary')).toBe('true');
    expect(
      within(rows[1]!).getByTestId('launcher-owned-row-primary').textContent,
    ).toBe('net-without-summary');
    expect(rows[1]!.getAttribute('data-has-summary')).toBe('false');
  });

  it('renders multiple rows in the order returned by the API', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({ solverNetId: 'net-a', status: 'launching' }),
        buildRecord({ solverNetId: 'net-b', status: 'launched' }),
        buildRecord({ solverNetId: 'net-c', status: 'paused' }),
      ],
    });
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-owned-row').length).toBe(3),
    );
    const rows = screen.getAllByTestId('launcher-owned-row');
    expect(rows[0].getAttribute('data-solvernet-id')).toBe('net-a');
    expect(rows[1].getAttribute('data-solvernet-id')).toBe('net-b');
    expect(rows[2].getAttribute('data-solvernet-id')).toBe('net-c');
    // Header CTA renders too when the list is non-empty.
    expect(screen.getByTestId('launcher-create-cta').getAttribute('href')).toBe(
      '/launcher/create',
    );
  });

  it('shows per-row recent-post counts and a zero-state for rows without counts (#918)', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({ solverNetId: 'net-a', manifestCid: 'cid-a' }),
        buildRecord({ solverNetId: 'net-b', manifestCid: 'cid-b' }),
      ],
    });
    vi.mocked(api.discovery.getTaskPostCounts).mockResolvedValue({
      ...emptyPostCounts(),
      windowEndBlock: 1000,
      byCid: {
        'cid-a': { h1: 2, h6: 5, h24: 9, windowEndBlock: 1000, windowEndTs: 0 },
      },
    });
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-owned-row').length).toBe(2),
    );
    await waitFor(() => {
      const cells = screen.getAllByTestId('launcher-owned-row-postcounts');
      expect(cells.length).toBe(2);
      // Row A has counts; row B falls back to the zero-state message.
      expect(cells[0]!.textContent).toMatch(/2/);
      expect(cells[0]!.textContent).toMatch(/9/);
      expect(cells[1]!.textContent).toMatch(/No recent posts/i);
    });
  });

  it('batches the recent-post query into ONE call with every cid (#918)', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [
        buildRecord({ solverNetId: 'net-a', manifestCid: 'cid-a' }),
        buildRecord({ solverNetId: 'net-b', manifestCid: 'cid-b' }),
      ],
    });
    wrap(<LauncherPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-owned-row').length).toBe(2),
    );
    await waitFor(() =>
      expect(api.discovery.getTaskPostCounts).toHaveBeenCalledWith(['cid-a', 'cid-b']),
    );
    // One batched call (initial render); never one-per-row.
    expect(api.discovery.getTaskPostCounts).toHaveBeenCalledTimes(1);
  });

  it('renders an unavailable message per row on a recent-post query error (#918)', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [buildRecord({ solverNetId: 'net-a', manifestCid: 'cid-a' })],
    });
    const err = new Error('discovery_unavailable') as Error & { code?: string };
    err.code = 'discovery_unavailable';
    vi.mocked(api.discovery.getTaskPostCounts).mockRejectedValue(err);
    wrap(<LauncherPage />);
    await waitFor(() => {
      const cell = screen.getByTestId('launcher-owned-row-postcounts');
      expect(cell.textContent).toMatch(/posts unavailable/i);
    });
  });

  it('navigates to /launcher/launched/:id on row click', async () => {
    vi.mocked(api.solvernets.listLaunched).mockResolvedValue({
      records: [buildRecord({ solverNetId: 'agent-1_prediction.v1-1_abcdef01' })],
    });
    const { nav } = wrap(<LauncherPage />);
    const row = await screen.findByTestId('launcher-owned-row');
    fireEvent.click(row);
    await waitFor(() =>
      expect(nav.history[nav.history.length - 1]).toBe(
        '/launcher/launched/agent-1_prediction.v1-1_abcdef01',
      ),
    );
  });
});
