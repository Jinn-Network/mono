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
    triggerDrip: (opts?: { singleDrip?: boolean }) => triggerDripMock(opts),
    restartDaemon: () => restartDaemonMock(),
  },
}));

// ActivitySections now uses SSE — mock so these tests don't open EventSource.
vi.mock('../api/events.js', () => ({
  useEventStream: vi.fn(() => ({ events: [], connected: false })),
}));

// Import after the mock so the page picks up the mocked client.
const { OverviewPage } = await import('./Overview.js');
const { detectJoinedSolverNet, operatorWaitingMessage } = await import('./overview/joined-solver-net.js');

beforeEach(async () => {
  getStatusMock.mockReset();
  getBootstrapMock.mockReset();
  claimRewardsMock.mockReset();
  triggerDripMock.mockReset();
  restartDaemonMock.mockReset();
  claimRewardsMock.mockResolvedValue({ ok: true });
  triggerDripMock.mockResolvedValue({ ok: true, attempts: 0, txHashes: [] });
  restartDaemonMock.mockResolvedValue({ ok: true });
  // Reset SSE mock to empty default between tests.
  const { useEventStream } = await import('../api/events.js');
  vi.mocked(useEventStream).mockReturnValue({ events: [], connected: false });
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

/** Match the OperatorCard's active SolverNet name exactly. */
function operatorCardName(name: string): (_: string, el: Element | null) => boolean {
  return (_, el) =>
    el?.tagName === 'SPAN' && el.textContent?.trim() === name;
}

describe('OverviewPage empty-state gating', () => {
  it('does not show the OperatorCard when the operator has joined nothing', async () => {
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

    // AlertBand retired (Task 1.6): the no_solvernets_joined notification
    // kind in AppShell handles the empty state globally. Overview shows nothing
    // in the joined-net slot when no net is configured.
    await screen.findByText(/network/i);
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    expect(screen.queryByText(operatorCardName('prediction'))).toBeNull();
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
      expect(screen.getByText(operatorCardName('prediction'))).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    expect(screen.getByText(/waiting for tasks/i)).toBeTruthy();
  });

  it('routes manifest-keyed joined prediction nets to the prediction waiting copy', () => {
    const joined = detectJoinedSolverNet(
      {
        bafybeipredmanifest: {
          name: 'Prediction Markets',
          manifestCid: 'bafybeipredmanifest',
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
        },
      },
      undefined,
      false,
      undefined,
    );

    expect(joined).toMatchObject({
      name: 'Prediction Markets',
      configId: 'bafybeipredmanifest',
      scopedStatusKey: 'predictionV1',
    });
    expect(
      operatorWaitingMessage(
        joined,
        {
          observedTasks: 0,
          activeTaskRuns: 0,
          completed: 0,
          failed: 0,
        },
        'Waiting for Tasks. SolverNet active, Harness loaded; no incoming Tasks since startup.',
      ),
    ).toMatch(/waiting for tasks/i);
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
      expect(screen.getByText(operatorCardName('prediction'))).toBeTruthy(),
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
        screen.getByText(operatorCardName('Prediction Markets')),
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
      expect(screen.getByText(operatorCardName('SWE-rebench v2'))).toBeTruthy(),
    );
    expect(screen.getByText(/network · swe-rebench v2/i)).toBeTruthy();
    expect(screen.queryByText(operatorCardName('prediction'))).toBeNull();
    // Find the "Change →" link in the OperatorCard (not "Change password" in FundsCard).
    const change = screen.getByText(/change\s*→/i).closest('a');
    expect(change?.getAttribute('href')).toBe('/operator#solvernets');
  });

  it('prefers SolverNet-scoped prediction totals for the manifest-keyed joined prediction path (jinn-mono-0t6p)', async () => {
    // Spec §12 / canonical shape: the operator joined prediction via
    // `joinedSolverNets[<manifestCid>]` and bound the prediction harness.
    // The joined entry's `name` is operator-chosen ("Prediction Markets"),
    // its `configId` is the manifestCid (NOT 'prediction'), and the
    // legacy `predictionV1.operator.solverNet.enabled` is false because the
    // user no longer maintains a `solverNets.prediction` short-name entry.
    // The fix must still route this case to the scoped predictionV1.totals.
    getStatusMock.mockResolvedValue({
      taskRuns: {
        totals: {
          observedTasks: 201,
          activeTaskRuns: 50,
          completed: 100,
          solutions: 41,
          verdicts: 62,
          failed: 81,
          settledFailed: 61,
          localErrors: 23,
        },
        inFlight: [],
        recentTasks: [],
      },
      predictionV1: {
        operator: {
          ok: true,
          // The daemon's prediction operator block is cold for this user —
          // their config has no legacy `solverNets.prediction`. The scoped
          // payload must still be preferred via the harness signal.
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
          nextAction: { description: 'Waiting for Tasks.' },
        },
        totals: {
          observedTasks: 22,
          activeTaskRuns: 5,
          solutions: 8,
          verdicts: 7,
          failed: 18,
          settledFailed: 12,
          localErrors: 6,
        },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      joinedSolverNets: {
        bafybeipredmanifest: {
          name: 'Prediction Markets',
          manifestCid: 'bafybeipredmanifest',
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
        },
      },
    });
    render(withProviders(<OverviewPage />));

    const networkTitle = await screen.findByText(
      /network · prediction markets/i,
    );
    const network = networkTitle.closest('section');
    expect(network).not.toBeNull();
    const card = network as HTMLElement;
    // Scoped predictionV1 totals surface — not the global rollup.
    expect(within(card).getByText('22')).toBeTruthy();
    expect(within(card).getByText('5')).toBeTruthy();
    expect(within(card).getByText('8')).toBeTruthy();
    expect(within(card).getByText('7')).toBeTruthy();
    expect(within(card).getByText('12')).toBeTruthy();
    expect(within(card).getByText('6')).toBeTruthy();
    // Global counts that don't belong to prediction must not appear here.
    expect(within(card).queryByText('201')).toBeNull();
    expect(within(card).queryByText('50')).toBeNull();
    expect(within(card).queryByText('41')).toBeNull();
    expect(within(card).queryByText('62')).toBeNull();
    expect(within(card).queryByText('61')).toBeNull();
    expect(within(card).queryByText('23')).toBeNull();
  });

  it('prefers SolverNet-scoped prediction totals when the joined net is prediction (jinn-mono-0t6p)', async () => {
    // The operator's local SQLite carries historical FAILED rows from
    // legacy solvernets in addition to prediction.v1. The NetworkCard
    // must show the scoped numbers so the operator sees the same fail
    // count as the public explorer.
    getStatusMock.mockResolvedValue({
      taskRuns: {
        totals: {
          observedTasks: 201,
          activeTaskRuns: 50,
          completed: 100,
          solutions: 41,
          verdicts: 62,
          failed: 81,
          settledFailed: 61,
          localErrors: 23,
        },
        inFlight: [],
        recentTasks: [],
      },
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: true },
          diagnostics: [],
        },
        totals: {
          observedTasks: 22,
          activeTaskRuns: 5,
          solutions: 8,
          verdicts: 7,
          failed: 18,
          settledFailed: 12,
          localErrors: 6,
        },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({
      solverNets: { prediction: { enabled: true, roles: ['solving'] } },
    });
    render(withProviders(<OverviewPage />));

    const networkTitle = await screen.findByText(/network · prediction/i);
    const network = networkTitle.closest('section');
    expect(network).not.toBeNull();
    const card = network as HTMLElement;
    // Scoped values surface in the card.
    expect(within(card).getByText('22')).toBeTruthy();
    expect(within(card).getByText('5')).toBeTruthy();
    expect(within(card).getByText('8')).toBeTruthy();
    expect(within(card).getByText('7')).toBeTruthy();
    expect(within(card).getByText('12')).toBeTruthy();
    expect(within(card).getByText('6')).toBeTruthy();
    // Global counts that don't belong to prediction must not appear here.
    expect(within(card).queryByText('201')).toBeNull();
    expect(within(card).queryByText('50')).toBeNull();
    expect(within(card).queryByText('41')).toBeNull();
    expect(within(card).queryByText('62')).toBeNull();
    expect(within(card).queryByText('61')).toBeNull();
    expect(within(card).queryByText('23')).toBeNull();
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
    // "Solutions delivered" hero stat retired — the count still shows up
    // scoped to the joined SolverNet inside NetworkCard (asserted above as
    // `45` within the network section).
    expect(screen.queryByText(/solutions delivered/i)).toBeNull();
    expect(screen.getByText(/working on current run/i)).toBeTruthy();
    expect(screen.queryByText(/no incoming tasks since startup/i)).toBeNull();
  });

  it('does not render the AlertBand get-started CTA — no_solvernets_joined notice handles it globally', async () => {
    // Render Overview in the no-solvernets-joined state (same payload shape as
    // the "shows the prompt" test above). After AlertBand is retired, neither
    // the "Get started" lead nor the "Pick a SolverNet" body should appear in
    // the Overview page — the global NotificationsList in AppShell handles it.
    getStatusMock.mockResolvedValue({
      predictionV1: {
        operator: {
          ok: true,
          solverNet: { name: 'prediction', enabled: false },
          diagnostics: [],
        },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
      fleet: { services: [] },
    });
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    render(withProviders(<OverviewPage />));

    // Wait for async data to settle then assert absence.
    await screen.findByText(/network/i);
    expect(screen.queryByText(/pick a solvernet/i)).toBeNull();
    expect(screen.queryByText(/get started/i)).toBeNull();
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
      expect(screen.getByText(operatorCardName('prediction'))).toBeTruthy(),
    );
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
  });

  it('shows no joined-net card when both payloads are empty', async () => {
    // AlertBand retired (Task 1.6): Overview shows nothing in the joined-net
    // slot when no net is configured — the global notification handles the CTA.
    getStatusMock.mockResolvedValue({ fleet: { services: [] } });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await screen.findByText(/network/i);
    expect(screen.queryByText(/pick a solvernet to participate in/i)).toBeNull();
    expect(screen.queryByText(operatorCardName('prediction'))).toBeNull();
  });

  it('renders the Node Health card with daemon + RPC rows in the right rail', async () => {
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

    await waitFor(() => expect(screen.getByTestId('node-health-card')).toBeTruthy());
    // The Node Health card replaces the old HeroStats Status tile — the
    // operator's daemon + RPC health live there now.
    expect(screen.getByTestId('node-health-daemon-row')).toBeTruthy();
    expect(screen.getByTestId('node-health-rpc-row')).toBeTruthy();
    expect(screen.queryByTestId('overview-status-stat')).toBeNull();
    expect(screen.queryByTestId('live-now-band')).toBeNull();
  });

  it('wires dashboard card actions to their real actions', async () => {
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

    // Funds + Rewards now live in FundsCard + RewardsCard (Task 3.3).
    expect(await screen.findByText(/funds/i)).toBeTruthy();
    expect(await screen.findByText(/rewards/i)).toBeTruthy();
    expect(screen.queryByText(/quick actions/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /manage wallet/i })).toBeNull();

    // RewardsCard "Claim" button (replaces HeroStats "Claim now").
    // The pending rewards are 1 JINN (1e18 wei) so the button is enabled.
    fireEvent.click(screen.getByRole('button', { name: /^claim$/i }));
    await waitFor(() => expect(claimRewardsMock).toHaveBeenCalledOnce());

    // FundsCard "Top up" button (replaces HeroStats "Top up").
    fireEvent.click(screen.getByRole('button', { name: /^top up$/i }));
    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());

    // Restart-from-Overview was retired with the HeroStats Status tile.
    // Daemon control now lives on the Node Health card (Stop + Start) and
    // is presently disabled until daemon-side endpoints land — the operator
    // restarts via terminal.
    expect(history.at(-1)).toBe('/overview');
  });
});

// ── Gas top-up: explicit click, no auto-fire ────────────────────────────────
//
// The Dashboard Gas top-up must be a single, explicit action: one click →
// exactly one faucet call, no re-firing while the Dashboard stays mounted, a
// one-line amount + tx-hash confirmation, and the button disabled while the
// request is in flight.
describe('OverviewPage gas top-up', () => {
  const gasStatus = {
    rewards: { pendingStakingRewardsWei: '1000000000000000000' },
    masterGas: { balanceWei: '23000000000000000', runwayDaysExcess: 4 },
    fleet: { services: [] },
    predictionV1: {
      operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
      totals: { observedTasks: 1, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
    },
  };

  it('fires the faucet exactly once per click, in single-drip mode', async () => {
    getStatusMock.mockResolvedValue(gasStatus);
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      deltaWei: '5000000000000000',
      attempts: 1,
    });
    render(withProviders(<OverviewPage />));

    const topUpButton = await screen.findByRole('button', { name: /^top up$/i });
    fireEvent.click(topUpButton);

    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());
    // Single-drip is the contract that prevents the server-side loop: the
    // page must ask for the one-shot path, never the bootstrap loop.
    expect(triggerDripMock).toHaveBeenCalledWith({ singleDrip: true });
  });

  it('does not re-fire the faucet while the Dashboard stays mounted', async () => {
    getStatusMock.mockResolvedValue(gasStatus);
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      deltaWei: '5000000000000000',
      attempts: 1,
    });
    const { rerender } = render(withProviders(<OverviewPage />));

    const topUpButton = await screen.findByRole('button', { name: /^top up$/i });
    fireEvent.click(topUpButton);
    await waitFor(() => expect(triggerDripMock).toHaveBeenCalledOnce());

    // Status polling re-renders the page repeatedly; none of those re-renders
    // may re-invoke the faucet. Force several re-renders and assert the call
    // count is still 1.
    for (let i = 0; i < 5; i++) {
      rerender(withProviders(<OverviewPage />));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(triggerDripMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a one-line confirmation with the amount and tx hash', async () => {
    getStatusMock.mockResolvedValue(gasStatus);
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    triggerDripMock.mockResolvedValue({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      deltaWei: '5000000000000000', // 0.005 ETH
      attempts: 1,
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByRole('button', { name: /top up/i }));

    const notice = await screen.findByTestId('dashboard-action-notice');
    expect(notice.textContent).toMatch(/0\.005000 ETH/);
    expect(notice.textContent).toMatch(/0xabc0…1234/);
  });

  it('disables the Top up button while the request is in flight', async () => {
    getStatusMock.mockResolvedValue(gasStatus);
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    let resolveDrip: (v: unknown) => void = () => undefined;
    triggerDripMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDrip = resolve;
      }),
    );
    render(withProviders(<OverviewPage />));

    const topUpButton = await screen.findByRole('button', { name: /^top up$/i });
    fireEvent.click(topUpButton);

    // While the faucet call is unresolved the button must be disabled.
    // FundsCard disables the button (via actionsDisabled) rather than relabelling it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^top up$/i })).toHaveProperty('disabled', true),
    );

    resolveDrip({
      ok: true,
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000001234'],
      deltaWei: '5000000000000000',
      attempts: 1,
    });

    // After resolution the button re-enables and the confirmation shows.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /top up/i })).toHaveProperty('disabled', false),
    );
    expect((await screen.findByTestId('dashboard-action-notice')).textContent).toMatch(/tx 0xabc0…1234/);
  });

  it('surfaces a faucet failure as an error notice', async () => {
    getStatusMock.mockResolvedValue(gasStatus);
    getBootstrapMock.mockResolvedValue({ solverNets: {} });
    triggerDripMock.mockResolvedValue({
      ok: false,
      rateLimited: true,
      reason: 'Faucet rate limited (1 claim per 24 hours per address).',
    });
    render(withProviders(<OverviewPage />));

    fireEvent.click(await screen.findByRole('button', { name: /top up/i }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/rate limited/i);
  });
});

/**
 * Issue #219: the live activity surface is a PRIMARY section on /overview
 * (the Dashboard). An operator who runs `jinn run` and lands on the
 * dashboard must see live task/event activity without navigating to
 * /operator (Settings). These tests assert the In-flight + Recent cards
 * render inline on Overview, with all card states operable.
 */
describe('OverviewPage activity surface (issue #219)', () => {
  it('renders the In-flight and Recent activity sections inline on the Dashboard', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      taskRuns: { totals: { activeTaskRuns: 0 }, inFlight: [], recentTasks: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-in-flight')).toBeTruthy();
    });
    expect(screen.getByTestId('overview-activity-recent')).toBeTruthy();
  });

  it('shows in-flight task rows from generic taskRuns without leaving /overview', async () => {
    const now = Date.now();
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      taskRuns: {
        totals: { activeTaskRuns: 1 },
        inFlight: [
          {
            requestId: 'req-abc12345',
            taskId: 'task-1',
            taskCid: 'bafkre...',
            solverType: 'swe-rebench-v2.v1',
            state: 'RUNNING',
            taskRole: 'restoration',
            stateUpdatedAt: now - 60_000,
            deliveryTxHash: null,
          },
        ],
      },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 1, activeTaskRuns: 1, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() => {
      expect(screen.getAllByTestId('overview-activity-in-flight-row')).toHaveLength(1);
    });
    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.queryByTestId('overview-activity-in-flight-empty')).toBeNull();
  });

  it('shows recent activity rows on the Dashboard', async () => {
    // Recent section sources from SSE — mock the hook to return an event.
    const { useEventStream } = await import('../api/events.js');
    vi.mocked(useEventStream).mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-dash-1',
          ts: '2026-05-07T13:46:45.710Z',
          kind: 'intent',
          message: 'request claimed',
          requestId: 'req-aaa',
          txHash: '0xabcdefabcdefabcdef',
        },
      ],
      connected: true,
    });
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

    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-recent-list')).toBeTruthy();
    });
    expect(screen.getByText(/request claimed/i)).toBeTruthy();
  });

  it('shows the empty / "no recent activity" states on the Dashboard', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      taskRuns: { totals: { activeTaskRuns: 0 }, inFlight: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
        recentTasks: [],
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-in-flight-empty')).toBeTruthy();
    });
    const recentEmpty = screen.getByTestId('overview-activity-recent-empty');
    expect(recentEmpty.textContent).toMatch(/no recent activity/i);
  });

  it('shows an operable error state on the Dashboard when /v1/status fails', async () => {
    getStatusMock.mockRejectedValue(new Error('status unavailable'));
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-error')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

// ── HarnessStatusPanel promotion — spec §2.9 ───────────────────────────────
//
// HarnessStatusPanel is a first-class harness-readiness surface (spec §2.9).
// It must render above the fold on /overview without requiring the operator
// to expand the "Advanced details" disclosure. This test fails before the
// promotion and passes after HarnessStatusPanel is moved out of <AdvancedDetails>.
describe('OverviewPage HarnessStatusPanel (spec §2.9)', () => {
  it('renders HarnessStatusPanel above the fold (not buried under Advanced details) — spec §2.9', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [] },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    // HarnessStatusPanel renders "Harness Status" (its section header) in the
    // loading/unavailable state ("Harness status unavailable") or after data loads.
    await waitFor(() => {
      expect(screen.getByText(/harness status/i)).toBeTruthy();
    });

    // AdvancedDetails was retired with the IA reshuffle — confirm the
    // empty disclosure isn't lingering.
    expect(screen.queryByRole('button', { name: /advanced details/i })).toBeNull();
  });
});

// ── IdentityCard promotion — spec §2.2 ─────────────────────────────────────
//
// IdentityCard is a first-class identity surface (spec §2.2). It must render
// above the fold on /overview without requiring the operator to expand the
// "Advanced details" disclosure. This test fails before the promotion and
// passes after IdentityCard is moved out of <AdvancedDetails>.
describe('OverviewPage IdentityCard (spec §2.2)', () => {
  it('renders IdentityCard above the fold (not buried under Advanced details) — spec §2.2', async () => {
    getStatusMock.mockResolvedValue({
      fleet: {
        services: [
          {
            index: 0,
            step: 'complete',
            agentId: 42,
            safeAddress: '0xSafe0000000000000000000000000000000000AA',
            safeBoundToAgent: true,
          },
        ],
      },
      predictionV1: {
        operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
        totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      },
    });
    getBootstrapMock.mockResolvedValue({});
    render(withProviders(<OverviewPage />));

    // IdentityCard section header "Identity" must be in the DOM as a
    // first-class section, not hidden behind an Advanced disclosure.
    await waitFor(() => {
      expect(screen.getByText('Identity')).toBeTruthy();
    });

    // AdvancedDetails was retired with the IA reshuffle — confirm the
    // empty disclosure isn't lingering.
    expect(screen.queryByRole('button', { name: /advanced details/i })).toBeNull();
  });
});
