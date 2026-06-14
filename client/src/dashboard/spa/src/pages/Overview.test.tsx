import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Toaster } from '../components/ui/sonner.js';

import type { JSX } from 'react';

/**
 * Overview integration tests. With the IA reshuffle, the per-card behaviour
 * (Activity / Wallet / Node Health) is covered by each card's own test file
 * under `./overview/*.test.tsx`. This file covers the wiring inside
 * Overview itself: dashboard-action notice and
 * the SPA-level action plumbing (top-up, claim, restart) through their
 * respective wallet/node-health surfaces.
 */

const getStatusMock = vi.fn();
const getBootstrapMock = vi.fn();
const triggerDripMock = vi.fn();
const getDripQuotaMock = vi.fn();
const restartDaemonMock = vi.fn();
const stopDaemonMock = vi.fn();
const retryAgentBindingMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    triggerDrip: (opts?: { singleDrip?: boolean; batch?: boolean }) => triggerDripMock(opts),
    getDripQuota: () => getDripQuotaMock(),
    restartDaemon: (opts?: { forceRespawn?: boolean }) => restartDaemonMock(opts),
    stopDaemon: () => stopDaemonMock(),
    retryAgentBinding: (opts: { serviceIndex: number }) => retryAgentBindingMock(opts),
  },
}));

// Import after the mock so the page picks up the mocked client.
const { OverviewPage } = await import('./Overview.js');

beforeEach(() => {
  getStatusMock.mockReset();
  getBootstrapMock.mockReset();
  triggerDripMock.mockReset();
  getDripQuotaMock.mockReset();
  restartDaemonMock.mockReset();
  stopDaemonMock.mockReset();
  retryAgentBindingMock.mockReset();
  triggerDripMock.mockResolvedValue({ ok: true, attempts: 0, txHashes: [] });
  getDripQuotaMock.mockResolvedValue({
    ok: true,
    dailyCap: 10,
    callsRemaining: 10,
    cooldownExpiresAt: null,
  });
  restartDaemonMock.mockResolvedValue({ ok: true });
  stopDaemonMock.mockResolvedValue({ ok: true });
});

function withProviders(node: JSX.Element, path = '/overview'): JSX.Element {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
      {/* sonner Toaster mounted so toast() calls render under jsdom; matches
          App.tsx's root-level Toaster placement. */}
      <Toaster />
    </QueryClientProvider>
  );
}

describe('OverviewPage layout', () => {
  it('renders the two-column page shell with Activity in the main column + Identity, Node Health, Wallet in the right rail', async () => {
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
    expect(screen.getByTestId('identity-card')).toBeTruthy();
    expect(screen.getByTestId('activity-card')).toBeTruthy();
    expect(screen.getByTestId('node-health-card')).toBeTruthy();
    expect(screen.getByTestId('wallet-card')).toBeTruthy();
    // Harness Readiness card removed from the overview (handled elsewhere).
    expect(screen.queryByTestId('harness-status-panel')).toBeNull();
  });

  it('mounts IdentityCard in the right rail paired with the Wallet card, and Activity in the main column', async () => {
    getStatusMock.mockResolvedValue({
      fleet: {
        services: [
          {
            index: 0,
            step: 'complete',
            serviceId: 50,
            agentId: 5879,
            safeAddress: '0xSafeAddr0000000000000000000000000000beef',
            safeBoundToAgent: true,
          },
        ],
      },
      taskRuns: { totals: {}, inFlight: [], recentTasks: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({
      master_address: '0x53e25264C86db85b6168F7824f5c39abd5281787',
      joinedSolverNets: {
        bafkreiswe: {
          manifestCid: 'bafkreiswe',
          name: 'SWE-rebench v2',
          roles: ['solver'],
          harness: 'hermes-agent',
        },
      },
    });
    render(withProviders(<OverviewPage />));

    const grid = await screen.findByTestId('overview-page-grid');
    const mainColumn = grid.firstElementChild;
    const rightRail = grid.lastElementChild;
    expect(mainColumn).not.toBeNull();
    expect(rightRail).not.toBeNull();
    expect(rightRail).not.toBe(mainColumn);

    const identityCard = await screen.findByTestId('identity-card');
    const walletCard = await screen.findByTestId('wallet-card');
    const activityCard = await screen.findByTestId('activity-card');

    // Identity + Wallet live in the right rail; Activity stays in the main column.
    expect(identityCard.parentElement).toBe(rightRail);
    expect(walletCard.parentElement).toBe(rightRail);
    expect(activityCard.parentElement).toBe(mainColumn);

    // Identity renders immediately above the Wallet card in the rail.
    const railChildren = Array.from(rightRail!.children) as HTMLElement[];
    const identityIdx = railChildren.findIndex((c) => c === identityCard);
    const walletIdx = railChildren.findIndex((c) => c === walletCard);
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(walletIdx).toBe(identityIdx + 1);

    // Harness Readiness card is gone.
    expect(screen.queryByTestId('harness-status-panel')).toBeNull();
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
    expect(tasks.textContent).toMatch(/succeeded/i);
  });
});

describe('OverviewPage wave-2 SOLVING-ON empty-state (issue #421)', () => {
  it('shows the no-active-SolverNet state when joinedSolverNets is empty', async () => {
    getStatusMock.mockResolvedValue({ fleet: { services: [] } });
    getBootstrapMock.mockResolvedValue({ joinedSolverNets: {} });
    render(withProviders(<OverviewPage />));
    await waitFor(() => {
      const joined = screen.getByTestId('activity-joined');
      expect(joined.textContent).toMatch(/no solvernets joined/i);
    });
  });

  it('ignores a stale legacy bootstrap.solverNets when joinedSolverNets is empty', async () => {
    getStatusMock.mockResolvedValue({ fleet: { services: [] } });
    // Even if the daemon were to accidentally echo a legacy block (it should
    // not after issue #421), the SPA must not fall through to it. The wave-2
    // symptom was "SOLVING ON prediction" persisting after every join was
    // left; this regression test pins the joined-only behaviour.
    getBootstrapMock.mockResolvedValue({
      solverNets: { prediction: { enabled: true, roles: ['solving'] } },
      joinedSolverNets: {},
    });
    render(withProviders(<OverviewPage />));
    await waitFor(() => {
      expect(screen.getByTestId('activity-joined').textContent).toMatch(/no solvernets joined/i);
    });
  });
});

describe('OverviewPage eviction surfaces (#773)', () => {
  it('does not render eviction banner or Re-stake when a service is evicted', async () => {
    getStatusMock.mockResolvedValue({
      fleet: {
        services: [
          {
            index: 0,
            step: 'complete',
            serviceId: 99,
            evicted: true,
            evictedSince: new Date().toISOString(),
          },
        ],
      },
      autoRestake: { enabled: true, checkIntervalMs: 60_000 },
      predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await screen.findByTestId('overview-page-grid');
    expect(screen.queryByTestId('overview-eviction-banner')).toBeNull();
    expect(screen.queryByTestId('overview-eviction-restake')).toBeNull();
    expect(screen.queryByText(/re-stake/i)).toBeNull();
  });
});

describe('OverviewPage Wallet wiring', () => {
  const baseStatus = {
    masterGas: { balanceWei: '23000000000000000', runwayDaysExcess: 4 },
    fleet: { services: [] },
    predictionV1: { operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] } },
  };

  it('wires the Top up button on the Wallet card to api.triggerDrip with batch (issue #560)', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      dailyCap: 10,
      callsRemaining: 9,
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());
    expect(triggerDripMock).toHaveBeenCalledWith({ batch: true });
  });

  it('passes the drip quota into the Wallet card (issue #560)', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    getDripQuotaMock.mockResolvedValue({
      ok: true,
      dailyCap: 10,
      callsRemaining: 4,
      cooldownExpiresAt: null,
    });
    render(withProviders(<OverviewPage />));

    const quota = await screen.findByTestId('wallet-topup-quota');
    expect(quota.textContent).toMatch(/4 of 10 top-ups left today/i);
  });

  it('surfaces a cap-reached message when the daemon returns topup_cooldown (issue #560)', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: false,
      reason: 'topup_cooldown',
      dailyCap: 10,
      callsRemaining: 0,
      cooldownExpiresAt: Date.now() + 60_000,
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    expect(await screen.findByText(/daily faucet cap reached/i)).toBeTruthy();
  });

  it('wires the tJINN-earned value from status.tJinn.safeBalanceWei', async () => {
    getStatusMock.mockResolvedValue({
      ...baseStatus,
      tJinn: {
        state: 'ready',
        chainId: 11155111,
        tokenAddress: '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A',
        safeBalanceWei: '1500000000000000000',
        operatorClaimedWei: '2750000000000000000',
        operatorMintedLast24hWei: '250000000000000000',
        safeCount: 1,
        services: [],
        error: null,
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    // The tJINN-earned value derives from status.tJinn.safeBalanceWei
    // (1.5 tJINN); the OLAS staking collector queue never reaches the SPA (#992).
    await waitFor(() =>
      expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('1.5000'),
    );
    expect(screen.getByTestId('tjinn-earned-24h-value').textContent).toBe('0.2500');
    expect(screen.getByText(/jinn earned last 24hrs/i)).toBeTruthy();
    const tjinnValue = screen.getByTestId('tjinn-earned-value');
    expect(tjinnValue.textContent).not.toBe('999.0000');
    expect(screen.queryByText('999.0000')).toBeNull();
    expect(screen.queryByText(/collector/i)).toBeNull();
    expect(screen.queryByTestId('wallet-claim')).toBeNull();
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
  });

  it('renders a confirmed-empty tJINN balance (ready + null) as 0', async () => {
    getStatusMock.mockResolvedValue({
      ...baseStatus,
      tJinn: {
        state: 'ready',
        chainId: 11155111,
        tokenAddress: '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A',
        safeBalanceWei: null,
        operatorClaimedWei: '0',
        safeCount: 1,
        services: [],
        error: null,
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('0.0000'),
    );
    // A confirmed-empty balance is distinguishable from loading — no state copy.
    expect(screen.queryByTestId('tjinn-earned-state')).toBeNull();
  });

  it('shows pending tJINN copy when status.tJinn is absent (older daemon)', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByTestId('tjinn-earned-value').textContent).toBe('pending'),
    );
    expect(screen.getByTestId('tjinn-earned-state').textContent).toMatch(
      /waiting for sepolia balance/i,
    );
  });

  it('surfaces a one-line gas top-up confirmation reporting the drip count + last tx (issue #560)', async () => {
    getStatusMock.mockResolvedValue(baseStatus);
    getBootstrapMock.mockResolvedValue({});
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHashes: [
        '0x1110000000000000000000000000000000000000000000000000000000001111',
        '0xabc0000000000000000000000000000000000000000000000000000000001234',
      ],
      dailyCap: 10,
      callsRemaining: 8,
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByTestId('wallet-topup'));
    // Toast surface: drip count + truncated last tx hash, queried by text
    // rather than testid (sonner doesn't surface testids on individual toasts).
    expect(await screen.findByText(/2 drips/)).toBeTruthy();
    expect(screen.getByText(/0xabc0…1234/)).toBeTruthy();
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
    expect(await screen.findByText(/rate limited/i)).toBeTruthy();
  });

  it('auto-clears the gas top-up confirmation after the autoClearMs window', async () => {
    vi.useFakeTimers();
    try {
      getStatusMock.mockResolvedValue(baseStatus);
      getBootstrapMock.mockResolvedValue({});
      getDripQuotaMock.mockResolvedValue({
        ok: true,
        dailyCap: 10,
        callsRemaining: 10,
        cooldownExpiresAt: null,
      });
      triggerDripMock.mockResolvedValue({
        ok: true,
        txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
        dailyCap: 10,
        callsRemaining: 9,
      });
      render(withProviders(<OverviewPage />));

      const topUp = await vi.waitFor(() => screen.getByTestId('wallet-topup'));
      fireEvent.click(topUp);
      const notice = await vi.waitFor(() => screen.getByText(/topped up|top-up sent/i));
      expect(notice.textContent).toMatch(/topped up|top-up sent/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      // Sonner's default dismiss is timer-driven; with fake timers + the
      // explicit 5s autoClearMs in runAction, the toast unmounts.
      expect(screen.queryByText(/topped up|top-up sent/i)).toBeNull();
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

