import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

/**
 * Overview integration tests. With the IA reshuffle, the per-card behaviour
 * (Activity / Wallet / Node Health) is covered by each card's own test file
 * under `./overview/*.test.tsx`. This file covers the wiring inside
 * Overview itself: the eviction banner, the dashboard-action notice, and
 * the SPA-level action plumbing (top-up, claim, restart) through their
 * respective wallet/node-health surfaces.
 */

const getStatusMock = vi.fn();
const getBootstrapMock = vi.fn();
const claimRewardsMock = vi.fn();
const triggerDripMock = vi.fn();
const restartDaemonMock = vi.fn();
const stopDaemonMock = vi.fn();
const restakeMock = vi.fn();
const retryAgentBindingMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    claimRewards: () => claimRewardsMock(),
    triggerDrip: (opts?: { singleDrip?: boolean }) => triggerDripMock(opts),
    restartDaemon: (opts?: { forceRespawn?: boolean }) => restartDaemonMock(opts),
    stopDaemon: () => stopDaemonMock(),
    restake: (serviceId: number) => restakeMock(serviceId),
    retryAgentBinding: (opts: { serviceIndex: number }) => retryAgentBindingMock(opts),
  },
}));

// Import after the mock so the page picks up the mocked client.
const { OverviewPage } = await import('./Overview.js');

beforeEach(() => {
  getStatusMock.mockReset();
  getBootstrapMock.mockReset();
  claimRewardsMock.mockReset();
  triggerDripMock.mockReset();
  restartDaemonMock.mockReset();
  stopDaemonMock.mockReset();
  restakeMock.mockReset();
  retryAgentBindingMock.mockReset();
  claimRewardsMock.mockResolvedValue({ ok: true });
  triggerDripMock.mockResolvedValue({ ok: true, attempts: 0, txHashes: [] });
  restartDaemonMock.mockResolvedValue({ ok: true });
  stopDaemonMock.mockResolvedValue({ ok: true });
  restakeMock.mockResolvedValue({ ok: true });
});

function withProviders(node: JSX.Element, path = '/overview'): JSX.Element {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

describe('OverviewPage layout', () => {
  it('renders the two-column page shell with Activity card + Node Health + Wallet', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      taskRuns: { totals: {}, inFlight: [], recentTasks: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    expect(await screen.findByTestId('overview-page-grid')).toBeTruthy();
    expect(screen.getByTestId('activity-card')).toBeTruthy();
    expect(screen.getByTestId('node-health-card')).toBeTruthy();
    expect(screen.getByTestId('wallet-card')).toBeTruthy();
  });

  it('passes joined SolverNets and task rows into the ActivityCard', async () => {
    const now = Date.now();
    getStatusMock.mockResolvedValue({
      fleet: { services: [] },
      taskRuns: {
        totals: {},
        inFlight: [],
        recentTasks: [
          {
            requestId: 'task-alpha-1234567',
            manifestCid: 'bafkreiswe',
            taskRole: 'restoration',
            state: 'COMPLETE',
            implName: 'hermes-agent',
            windowStartTs: now - 60_000,
            stateUpdatedAt: now - 30_000,
            deliveryTxHash: '0xabc',
          },
        ],
      },
      predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
    });
    getBootstrapMock.mockResolvedValue({
      joinedSolverNets: {
        bafkreiswe: {
          manifestCid: 'bafkreiswe',
          name: 'SWE-rebench v2',
          roles: ['solver', 'evaluator'],
          harness: 'hermes-agent',
        },
      },
    });
    render(withProviders(<OverviewPage />));

    // Both queries need to settle — Activity reads status (5s poll) AND
    // bootstrap (30s poll). waitFor gives both a chance to land.
    await waitFor(() =>
      expect(screen.getByTestId('activity-joined').textContent).toContain('SWE-rebench v2'),
    );
    const tasks = await screen.findByTestId('activity-tasks-table');
    expect(tasks.textContent).toContain('task-a');
    expect(tasks.textContent).toMatch(/complete/i);
  });
});

describe('OverviewPage eviction banner', () => {
  it('renders the inline eviction banner when a service is evicted', async () => {
    getStatusMock.mockResolvedValue({
      fleet: {
        services: [
          { index: 0, step: 'complete', serviceId: 99, evicted: true },
        ],
      },
      predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    const banner = await screen.findByTestId('overview-eviction-banner');
    expect(banner.textContent).toMatch(/service evicted/i);
  });

  it('invokes api.restake with the evicted service id when Re-stake is clicked', async () => {
    getStatusMock.mockResolvedValue({
      fleet: {
        services: [
          { index: 0, step: 'complete', serviceId: 42, evicted: true },
        ],
      },
      predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('overview-eviction-restake'));
    await waitFor(() => expect(restakeMock).toHaveBeenCalledWith(42));
  });
});

describe('OverviewPage Wallet wiring', () => {
  const baseStatus = {
    rewards: { pendingStakingRewardsWei: '1000000000000000000' },
    masterGas: { balanceWei: '23000000000000000', runwayDaysExcess: 4 },
    fleet: { services: [] },
    predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
  };

  it('wires the Top up button on the Wallet card to api.triggerDrip with singleDrip', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      deltaWei: '5000000000000000',
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());
    expect(triggerDripMock).toHaveBeenCalledWith({ singleDrip: true });
  });

  it('wires the Claim button on the Wallet card to api.claimRewards', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    // Wait for the claimable balance to populate so the button enables.
    await waitFor(() =>
      expect((screen.getByTestId('wallet-claim') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('wallet-claim'));
    await waitFor(() => expect(claimRewardsMock).toHaveBeenCalledOnce());
  });

  it('surfaces a one-line gas top-up confirmation with the tx hash + amount', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      deltaWei: '5000000000000000', // 0.005 ETH
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    const notice = await screen.findByTestId('dashboard-action-notice');
    expect(notice.textContent).toMatch(/0\.005000 ETH/);
    expect(notice.textContent).toMatch(/0xabc0…1234/);
  });

  it('surfaces a faucet failure as an error notice', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: false,
      rateLimited: true,
      reason: 'Faucet rate limited (1 claim per 24 hours per address).',
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/rate limited/i);
  });

  it('auto-clears the gas top-up confirmation after the autoClearMs window', async () => {
    vi.useFakeTimers();
    try {
      getStatusMock.mockResolvedValue(baseStatus);
      getBootstrapMock.mockResolvedValue({});
      triggerDripMock.mockResolvedValue({
        ok: true,
        txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
        deltaWei: '5000000000000000',
      });
      render(withProviders(<OverviewPage />));

      const topUp = await vi.waitFor(() => screen.getByTestId('wallet-topup'));
      fireEvent.click(topUp);
      const notice = await vi.waitFor(() => screen.getByTestId('dashboard-action-notice'));
      expect(notice.textContent).toMatch(/topped up|top-up sent/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.queryByTestId('dashboard-action-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OverviewPage Node Health wiring', () => {
  const baseStatus = {
    fleet: { services: [] },
    predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
  };

  it('wires the Restart button to api.restartDaemon with forceRespawn', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('node-health-restart'));
    await waitFor(() => expect(restartDaemonMock).toHaveBeenCalledOnce());
    expect(restartDaemonMock).toHaveBeenCalledWith({ forceRespawn: true });
  });
});
