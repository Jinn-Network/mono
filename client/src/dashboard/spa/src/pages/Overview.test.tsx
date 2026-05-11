import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Overview's empty-state gating depends on two payloads now: the
 * `predictionV1` operator status and the `bootstrap.solverNets` map
 * (spec §12, the operator's joined-SolverNets dictionary). We mock both
 * per-test so the page receives the shape we want to assert against.
 *
 * `detectJoinedSolverNet` accepts:
 *   1. the manifest-keyed `joinedSolverNets` shape — wins
 *   2. the new manifestCid-keyed shape (`solverNets[<cid>].roles`)
 *   3. the legacy short-name shape (`solverNets.prediction.enabled` or roles)
 *   4. the predictionV1 status flag/roles as a last-resort signal
 */
const getStatusMock = vi.fn();
const getBootstrapMock = vi.fn();
const claimRewardsMock = vi.fn();
const triggerDripMock = vi.fn();
const restartDaemonMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    claimRewards: () => claimRewardsMock(),
    triggerDrip: () => triggerDripMock(),
    restartDaemon: () => restartDaemonMock(),
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
  claimRewardsMock.mockResolvedValue({ ok: true });
  triggerDripMock.mockResolvedValue({ ok: true, attempts: 0, txHashes: [] });
  restartDaemonMock.mockResolvedValue({ ok: true });
});

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

function renderOverviewWithMemory(): { history: string[] } {
  const memory = memoryLocation({ path: '/overview', record: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={memory.hook}><OverviewPage /></Router>
    </QueryClientProvider>,
  );
  return { history: memory.history };
}

/** Match the OperatorCard's `<span>Your {name}</span>` eyebrow exactly. */
function operatorEyebrow(name: string): (_: string, el: Element | null) => boolean {
  return (_, el) =>
    el?.tagName === 'SPAN' && el.textContent?.trim() === `Your ${name}`;
}

describe('OverviewPage empty-state gating', () => {
  it('shows the "Pick a SolverNet" prompt when the operator has joined nothing', async () => {
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
          nextAction: { description: 'Waiting for Tasks. SolverNet active, Harness loaded; no incoming Tasks since startup.' },
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    render(withProviders(<OverviewPage />));

    expect(await screen.findByText(/pick a solvernet to participate in/i)).toBeTruthy();
    // OperatorCard's "Your <name>" eyebrow must NOT render in this state.
    expect(screen.queryByText(operatorEyebrow('prediction'))).toBeNull();
  });

  it('shows the OperatorCard from the legacy `enabled` flag (predecessor compat)', async () => {
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: true },
          diagnostics: [],
          nextAction: { description: 'Waiting for tasks.' },
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      solverNets: {
        prediction: { enabled: true, roles: ['solving'] },
      },
    });
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByText(operatorEyebrow('prediction'))).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    expect(screen.getByText(/waiting for tasks/i)).toBeTruthy();
  });

  it('shows the OperatorCard from operator roles even when legacy enabled is false', async () => {
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: false, roles: ['solving'] },
          diagnostics: [],
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByText(operatorEyebrow('prediction'))).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    expect(screen.getByText(/^solver$/i)).toBeTruthy();
  });

  it('shows the OperatorCard for the new manifestCid-keyed shape (spec §12)', async () => {
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          // Crucially: the predictionV1 flag is `false` — the new shape
          // must light up the card on its own.
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      solverNets: {
        bafybeiaaa: {
          name: 'Prediction Markets',
          manifestCid: 'bafybeiaaa',
          roles: ['solver'],
        },
      },
    });
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(
        screen.getByText(operatorEyebrow('Prediction Markets')),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    // Solver pill (the new schema's 'solver' maps to OperatorCard's 'solving').
    expect(screen.getByText(/^solver$/i)).toBeTruthy();
  });

  it('prefers joinedSolverNets over legacy prediction status for SWE-rebench v2', async () => {
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
        },
        totals: { observedTasks: 2, activeTaskRuns: 1, solutions: 1, verdicts: 1, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      joinedSolverNets: {
        bafkreiswe: {
          manifestCid: 'bafkreiswe',
          name: 'SWE-rebench v2',
          roles: ['solver', 'evaluator'],
        },
      },
      solverNets: {
        prediction: { enabled: true, roles: ['solving'] },
      },
    });
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByText(operatorEyebrow('SWE-rebench v2'))).toBeTruthy(),
    );
    expect(screen.getByText(/network · swe-rebench v2/i)).toBeTruthy();
    expect(screen.queryByText(operatorEyebrow('prediction'))).toBeNull();
    const configure = screen.getByText(/configure/i).closest('a');
    expect(configure?.getAttribute('href')).toBe('/operator#solvernets/bafkreiswe');
  });

  it('uses generic task-run totals before stale prediction counters', async () => {
    getStatusMock.mockResolvedValue({
      taskRuns: {
        totals: {
          observedTasks: 102,
          activeTaskRuns: 3,
          completed: 87,
          solutions: 45,
          verdicts: 42,
          failed: 63,
        },
        inFlight: [],
        recentTasks: [],
      },
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
        },
        totals: { observedTasks: 10, activeTaskRuns: 0, solutions: 5, verdicts: 0, failed: 5 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      joinedSolverNets: {
        bafkreiswe: {
          manifestCid: 'bafkreiswe',
          name: 'SWE-rebench v2',
          roles: ['solver', 'evaluator'],
        },
      },
    });
    render(withProviders(<OverviewPage />));

    const networkTitle = await screen.findByText(/network · swe-rebench v2/i);
    const network = networkTitle.closest('section');
    expect(network).not.toBeNull();
    expect(within(network as HTMLElement).getByText('102')).toBeTruthy();
    expect(within(network as HTMLElement).getByText('3')).toBeTruthy();
    expect(within(network as HTMLElement).getByText('45')).toBeTruthy();
    expect(within(network as HTMLElement).getByText('42')).toBeTruthy();
    expect(within(network as HTMLElement).getByText('63')).toBeTruthy();
    expect(within(network as HTMLElement).queryByText('10')).toBeNull();
    expect(screen.getByText(/solutions delivered/i)).toBeTruthy();
    expect(screen.getByText(/working on current run/i)).toBeTruthy();
    expect(screen.queryByText(/no incoming tasks since startup/i)).toBeNull();
  });

  it('shows the OperatorCard from the predictionV1 status as a back-compat signal', async () => {
    // No bootstrap.solverNets at all; predictionV1.solverNet.enabled wins.
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: true },
          diagnostics: [],
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() =>
      expect(screen.getByText(operatorEyebrow('prediction'))).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
  });

  it('shows the prompt when both payloads are empty', async () => {
    getStatusMock.mockResolvedValue({ fleet: { services: [] } });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    expect(await screen.findByText(/pick a solvernet to participate in/i)).toBeTruthy();
    expect(screen.queryByText(operatorEyebrow('prediction'))).toBeNull();
  });

  it('CTA on empty-state deep-links into /operator#solvernets', async () => {
    getStatusMock.mockResolvedValue({ fleet: { services: [] } });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    const cta = await screen.findByText(/configure\s*→/i);
    expect(cta.closest('a')?.getAttribute('href')).toBe(
      '/operator#solvernets',
    );
  });

  it('shows compact live status in the HeroStats row', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() => expect(screen.getByTestId('overview-status-stat')).toBeTruthy());
    expect(screen.getByTestId('overview-status-stat').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByTestId('live-now-band')).toBeNull();
  });

  it('wires quick actions to their real dashboard actions', async () => {
    getStatusMock.mockResolvedValue({
      rewards: { pendingStakingRewardsWei: '1000000000000000000' },
      masterGas: { balanceWei: '23000000000000000', runwayDaysExcess: 4 },
      fleet: { services: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 1, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
    });
    getBootstrapMock.mockResolvedValue({
      joinedSolverNets: {
        bafkreiswe: {
          manifestCid: 'bafkreiswe',
          name: 'SWE-rebench v2',
          roles: ['solver', 'evaluator'],
        },
      },
    });
    const { history } = renderOverviewWithMemory();

    fireEvent.click(await screen.findByRole('button', { name: /claim jinn/i }));
    await waitFor(() => expect(claimRewardsMock).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /top up gas/i }));
    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /restart node/i }));
    await waitFor(() => expect(restartDaemonMock).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /manage wallet/i }));
    await waitFor(() => expect(history.at(-1)).toBe('/operator#security'));
  });
});
