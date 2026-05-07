import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
 *   1. the new manifestCid-keyed shape (`solverNets[<cid>].roles`) — wins
 *   2. the legacy short-name shape (`solverNets.prediction.enabled` or roles)
 *   3. the predictionV1 status flag/roles as a last-resort signal
 */
const getStatusMock = vi.fn();
const getBootstrapMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    claimRewards: async () => ({ ok: true }),
    restartDaemon: async () => ({ ok: true }),
  },
}));

// Import after the mock so the page picks up the mocked client.
const { OverviewPage } = await import('./Overview.js');

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
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
});
