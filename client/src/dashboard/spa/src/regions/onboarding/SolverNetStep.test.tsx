import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SolverNetStep } from './SolverNetStep.js';

const join = vi.fn();
const listRegistry = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    solvernets: { listRegistry: () => listRegistry() },
    operator: { join: (...a: unknown[]) => join(...a) },
  },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const SWE_CID = 'bafkreichswerebenchv2example';

const sweSummary = {
  manifestCid: SWE_CID,
  solverNetId: 'sn-swe-1',
  name: 'SWE-rebench v2',
  network: 'base-sepolia',
  launcherAgentId: '42',
  launcherSafeAddress: '0xabc0000000000000000000000000000000000001',
  status: 'launched' as const,
  statusUpdatedAt: '2026-06-01T00:00:00.000Z',
  contractId: 'swe-rebench-v2',
  contractVersion: 'v1',
  solutionPriceWei: '0',
  verdictPriceWei: '0',
  openRoles: ['solver' as const, 'evaluator' as const],
  anchorBlock: 1,
};
const predictionSummary = {
  ...sweSummary,
  manifestCid: 'bafkreichpredictionexample',
  name: 'Prediction',
  contractId: 'prediction',
  solverNetId: 'sn-pred-1',
};

function listResponse(summaries: unknown[]) {
  return { summaries, lastRefreshedAt: '2026-06-01T00:00:00.000Z', lastError: null };
}

describe('SolverNetStep (live registry)', () => {
  beforeEach(() => {
    join.mockReset();
    join.mockResolvedValue({
      ok: true,
      restartRequired: false,
      manifestCid: SWE_CID,
      config: { manifestCid: SWE_CID, roles: ['solver'], name: 'SWE-rebench v2' },
    });
    listRegistry.mockReset();
  });

  it('renders only the swe-rebench-v2 card (filtered from the live registry)', async () => {
    listRegistry.mockResolvedValue(listResponse([predictionSummary, sweSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-card')).toBeTruthy(),
    );
    expect(screen.queryByText('Prediction')).toBeNull();
  });

  it('shows a non-blocking loading state while the subsystem is starting (503)', async () => {
    const notReady = Object.assign(new Error('503 subsystem_not_ready'), {
      code: 'subsystem_not_ready',
      status: 503,
    });
    listRegistry.mockRejectedValue(notReady);
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-starting')).toBeTruthy(),
    );
    // 503 must NOT surface the hard error alert.
    expect(screen.queryByTestId('onboarding-solvernet-error')).toBeNull();
  });

  it('shows a hard error alert on a non-503 failure', async () => {
    listRegistry.mockRejectedValue(new Error('network'));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-error')).toBeTruthy(),
    );
  });

  it('shows a starting state when the registry has no swe-rebench-v2 entry yet', async () => {
    listRegistry.mockResolvedValue(listResponse([predictionSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-starting')).toBeTruthy(),
    );
  });

  it('joins as solver under the real manifest cid', async () => {
    listRegistry.mockResolvedValue(listResponse([sweSummary]));
    const onJoined = vi.fn();
    render(wrap(<SolverNetStep onJoined={onJoined} joinedCids={[]} />));
    await waitFor(() => screen.getByTestId('onboarding-solvernet-join'));
    fireEvent.click(screen.getByTestId('onboarding-solvernet-join'));
    await waitFor(() => expect(join).toHaveBeenCalled());
    expect(join.mock.calls[0]![0]).toBe(SWE_CID);
    expect(join.mock.calls[0]![1]).toMatchObject({ roles: ['solver'] });
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(SWE_CID));
  });

  it('reflects an already-joined state without re-joining', async () => {
    listRegistry.mockResolvedValue(listResponse([sweSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[SWE_CID]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-card')).toBeTruthy(),
    );
    expect(screen.getByTestId('onboarding-solvernet-joined')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-solvernet-join')).toBeNull();
  });
});
