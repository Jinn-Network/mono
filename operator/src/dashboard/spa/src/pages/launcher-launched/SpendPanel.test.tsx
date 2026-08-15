import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpendPanel } from './SpendPanel.js';
import type {
  LauncherStatusResponse,
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';

import type { JSX } from 'react';

function buildRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn-1',
    manifestCid: 'bafybeig',
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

function buildManifest(
  overrides: Partial<SolverNetManifestV1> = {},
): SolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'sn-1',
    network: 'base-sepolia',
    name: 'Polymarket',
    description: '',
    launcher: {
      safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      agentEoa: '0xeoa',
      agentId: '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: { task: {}, solution: {}, verdict: {} },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 1,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'e',
        deterministic: true,
        inputs: [],
        output: '',
        implementation: '',
      },
      aggregationFunction: { id: 'a', deterministic: true, inputs: [], output: '' },
    },
    solutionPriceWei: '100',
    verdictPriceWei: '50',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-05T00:00:00Z',
    launchedAt: '2026-05-05T00:00:00Z',
    signature: { alg: 'eip-191', signer: '0xabc', value: '0xabc' },
    ...overrides,
  };
}

function buildRecordSummary(
  overrides: Partial<NonNullable<LaunchedSolverNetRecord['summary']>> = {},
): NonNullable<LaunchedSolverNetRecord['summary']> {
  return {
    manifestCid: 'bafybeig',
    solverNetId: 'sn-1',
    name: 'SWE-rebench v2',
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solutionPriceWei: '10000000000',
    verdictPriceWei: '5000000000',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 1,
    ...overrides,
  };
}

function buildStatusResponse(
  netName: string,
  safeBalanceWei: string,
  solverType?: string,
): LauncherStatusResponse {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T15:00:00Z',
    nets: [
      {
        name: netName,
        ...(solverType ? { solverType } : {}),
        generator: { state: 'active', cadenceMs: 21600000, stale: false },
        openTasks: 0,
        budget: {
          safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
          safeBalanceWei,
          reservedBudgetWei: '0',
        },
      },
    ],
  };
}

function wrap(ui: JSX.Element): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('SpendPanel', () => {
  it('renders manifest prices and Safe address up front', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      buildStatusResponse('Polymarket', '1500000000000000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest()}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-safe-balance').textContent,
      ).toContain('1.5 ETH'),
    );
    expect(screen.getByTestId('launcher-launched-spend-solution-price').textContent).toContain('100 wei');
    expect(screen.getByTestId('launcher-launched-spend-verdict-price').textContent).toContain('50 wei');
    expect(screen.getByTestId('launcher-launched-spend-safe-address').textContent).toMatch(/0xE64b…B5CF/);
  });

  it('projects runway from a claim-gas-inclusive per-Task cost', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // balance = 4 × per-Task cost (3_512_500_000_000 wei).
      buildStatusResponse('Polymarket', '14050000000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000', // 1000 gwei
          verdictPriceWei: '500000000000', // 500 gwei
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-runway').textContent,
      ).toContain('4 Tasks'),
    );
    // Per-Task cost = 1000 gwei + 500 gwei + 2012.5 gwei claim gas = 3512.5 gwei.
    expect(
      screen.getByTestId('launcher-launched-spend-per-task').textContent,
    ).toContain('3512.5 gwei');
  });

  it('surfaces a low-runway state message below 100 Tasks', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // 99 × per-Task cost (3_512_500_000_000) = 347_737_500_000_000.
      buildStatusResponse('Polymarket', '347737500000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000',
          verdictPriceWei: '500000000000',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-low-runway'),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId('launcher-launched-spend-low-runway').textContent,
    ).toMatch(/runway low/i);
    // AC3: the message must point the operator at the Overview faucet and the
    // daemon's auto-forward behaviour (#573).
    expect(
      screen.getByTestId('launcher-launched-spend-low-runway').textContent,
    ).toMatch(
      /top up your wallet from the overview faucet — the daemon forwards eth to the safe automatically\./i,
    );
  });

  it('hides the low-runway message at or above 100 Tasks', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // 100 × per-Task cost = 351_250_000_000_000.
      buildStatusResponse('Polymarket', '351250000000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000',
          verdictPriceWei: '500000000000',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-runway').textContent,
      ).toContain('100 Tasks'),
    );
    expect(
      screen.queryByTestId('launcher-launched-spend-low-runway'),
    ).toBeNull();
  });

  it('matches launcher status by manifest solver type when names differ', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      buildStatusResponse('swe-rebench-v2', '1500', 'swe-rebench-v2.v1'),
    );
    const predictionContract = buildManifest().contract;
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          name: 'SWE-rebench v2',
          contract: {
            ...predictionContract,
            id: 'swe-rebench-v2',
            version: 'v1',
          },
          solutionPriceWei: '100',
          verdictPriceWei: '50',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-safe-balance').textContent,
      ).toContain('1,500 wei'),
    );
  });

  it('formats small live prices as gwei instead of scientific ETH notation', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      buildStatusResponse('swe-rebench-v2', '2000000000000000', 'swe-rebench-v2.v1'),
    );
    const predictionContract = buildManifest().contract;
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          name: 'SWE-rebench v2',
          contract: {
            ...predictionContract,
            id: 'swe-rebench-v2',
            version: 'v1',
          },
          solutionPriceWei: '10000000000',
          verdictPriceWei: '5000000000',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-per-task').textContent,
      ).toBe('2027.5 gwei'),
    );
    // Per-Task = 10 gwei + 5 gwei + 2012.5 gwei claim gas = 2027.5 gwei.
    expect(screen.getByTestId('launcher-launched-spend-solution-price').textContent).toBe('10 gwei');
    expect(screen.getByTestId('launcher-launched-spend-verdict-price').textContent).toBe('5 gwei');
    expect(screen.getByTestId('launcher-launched-spend-per-task').textContent).not.toContain('e-');
  });

  it('uses the launched record summary for prices while the manifest is loading', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      buildStatusResponse('SWE-rebench v2', '2000000000000000', 'swe-rebench-v2.v1'),
    );
    wrap(
      <SpendPanel
        record={buildRecord({ summary: buildRecordSummary() })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-per-task').textContent,
      ).toBe('2027.5 gwei'),
    );
    // Per-Task = 10 gwei + 5 gwei + 2012.5 gwei claim gas = 2027.5 gwei.
    expect(screen.getByTestId('launcher-launched-spend-solution-price').textContent).toBe('10 gwei');
    expect(screen.getByTestId('launcher-launched-spend-verdict-price').textContent).toBe('5 gwei');
  });

  it('falls back to "balance unavailable" when no matching launcher-status entry', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      buildStatusResponse('SomeOtherNet', '999'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({ name: 'Polymarket' })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-safe-balance').textContent,
      ).toBe('unavailable'),
    );
    expect(
      screen.getByTestId('launcher-launched-spend-runway').textContent,
    ).toMatch(/manifest or balance unavailable/);
  });

  it('renders error indicator when fetchLauncherStatus rejects', async () => {
    const fetchLauncherStatus = vi.fn().mockRejectedValue(new Error('500 boom'));
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest()}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-spend-error')).toBeTruthy(),
    );
  });

  it('still renders without a manifest (read-only fields go to —)', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '',
      nets: [],
    } satisfies LauncherStatusResponse);
    wrap(
      <SpendPanel
        record={buildRecord()}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    // No manifest → no entry match → safe balance "unavailable".
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-safe-balance').textContent,
      ).toBe('unavailable'),
    );
    expect(screen.getByTestId('launcher-launched-spend-solution-price').textContent).toBe('—');
    expect(screen.getByTestId('launcher-launched-spend-verdict-price').textContent).toBe('—');
  });
});
