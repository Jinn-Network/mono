import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Tests for the operator-side join flow keyed by manifestCid (Task 21).
 * Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12.
 *
 * Each test mocks `api.solvernets.getManifest`, `api.getSolverNets`, and
 * `api.operator.{join,leave}`; mocks must be installed before the component
 * imports the api module — same dynamic-import dance as
 * `RegistryCatalog.test.tsx` and `Overview.test.tsx`.
 */

const apiMock = vi.hoisted(() => ({
  getManifest: vi.fn(),
  getSolverNets: vi.fn(),
  operatorJoin: vi.fn(),
  operatorLeave: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  api: {
    solvernets: {
      getManifest: (cid: string) => apiMock.getManifest(cid),
    },
    getSolverNets: () => apiMock.getSolverNets(),
    operator: {
      join: (cid: string, body: unknown) => apiMock.operatorJoin(cid, body),
      leave: (cid: string) => apiMock.operatorLeave(cid),
    },
  },
}));

const { JoinFlow } = await import('./JoinFlow.js');

const baseManifest = {
  schemaVersion: 'solvernet.manifest.v1' as const,
  solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
  network: 'base-sepolia' as const,
  name: 'Prediction Markets',
  description: 'Forecast resolved outcomes; rewarded by Brier score.',
  launcher: {
    safeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
    agentEoa: '0x1111111111111111111111111111111111111111',
    agentId: '5474',
  },
  contract: {
    id: 'prediction',
    version: 'v1',
    schemas: { task: {}, solution: {}, verdict: {} },
    claimPolicyDefaults: {
      mode: 'parallel' as const,
      maxClaims: 5,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 600,
    },
    credentialRequirements: { creator: [], solver: [], evaluator: [] },
    evaluationFunction: {
      id: 'predictionV1Eval',
      deterministic: true,
      inputs: ['solution.predictionPbool'],
      output: 'verdict.brierScore',
      implementation: 'jinn-builtin/prediction-v1-eval@1.0',
    },
    aggregationFunction: {
      id: 'predictionV1Agg',
      deterministic: true,
      inputs: ['verdict.brierScore'],
      output: 'aggregate.score',
    },
  },
  solutionPriceWei: '1000000000000000',
  verdictPriceWei: '500000000000000',
  openRoles: ['solver', 'evaluator'] as Array<'solver' | 'evaluator'>,
  createdAt: '2026-05-05T00:00:00Z',
  launchedAt: '2026-05-05T00:01:00Z',
  signature: {
    alg: 'eip-191' as const,
    signer: '0x1111111111111111111111111111111111111111',
    value: '0xdeadbeef',
  },
};

const baseCatalog = {
  schemaVersion: 1 as const,
  generatedAt: '2026-05-05T00:00:00Z',
  nets: [
    {
      name: 'prediction',
      description: 'Prediction Markets',
      state: 'live' as const,
      intrinsicSolverType: 'prediction.v1',
      supportedRoles: ['solving' as const, 'evaluating' as const],
      compatibleHarnesses: [
        {
          name: 'claude-code-learner',
          version: '0.1.0',
          supportsRoles: ['solving' as const, 'evaluating' as const],
        },
      ],
      compatiblePlugins: [
        { name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' },
      ],
    },
  ],
};

function wrap(
  ui: JSX.Element,
  initialPath = '/operator/join/bafybeiaaa',
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
      <Router hook={nav.hook}>
        <Route path="/operator/join/:cid">{ui}</Route>
      </Router>
    </QueryClientProvider>,
  );
  return { rendered, nav };
}

beforeEach(() => {
  apiMock.getManifest.mockReset();
  apiMock.getSolverNets.mockReset();
  apiMock.operatorJoin.mockReset();
  apiMock.operatorLeave.mockReset();

  apiMock.getManifest.mockResolvedValue({
    manifest: baseManifest,
    lifecycle: {
      status: 'launched' as const,
      statusUpdatedAt: '2026-05-05T00:00:00Z',
      sourceBlock: 1,
    },
  });
  apiMock.getSolverNets.mockResolvedValue(baseCatalog);
  apiMock.operatorJoin.mockResolvedValue({
    ok: true,
    restartRequired: true,
    manifestCid: 'bafybeiaaa',
    config: { manifestCid: 'bafybeiaaa', roles: ['solver'] },
  });
});

afterEach(() => {
  cleanup();
});

describe('JoinFlow — manifest fetch', () => {
  it('renders the manifest summary on mount', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );
    expect(screen.getByText(/join prediction markets/i)).toBeTruthy();
    expect(screen.getByTestId('join-flow-open-roles').textContent).toMatch(
      /solver, evaluator/i,
    );
    expect(screen.getByTestId('join-flow-manifest-cid').textContent).toBe(
      'bafybeiaaa',
    );
  });

  it('shows a loading state while the manifest is in flight', () => {
    apiMock.getManifest.mockReturnValue(new Promise(() => undefined));
    wrap(<JoinFlow />);
    expect(screen.getByTestId('join-flow-loading')).toBeTruthy();
  });

  it('shows an error state with retry when the manifest fetch fails', async () => {
    apiMock.getManifest.mockRejectedValue(new Error('404 not found on /v1/solvernets/registry/bafybeiaaa'));
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-error')).toBeTruthy(),
    );
    expect(screen.getByText(/failed to load manifest/i)).toBeTruthy();
    expect(screen.getByTestId('join-flow-retry')).toBeTruthy();
  });
});

describe('JoinFlow — role selection', () => {
  it('hides the harness picker when only the evaluator role is selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Evaluator'));

    expect(screen.queryByTestId('join-flow-solver-fields')).toBeNull();
    expect(screen.getByTestId('join-flow-evaluator-info')).toBeTruthy();
    expect(
      screen.getByText(
        /jinn-builtin\/prediction-v1-eval@1\.0/i,
      ),
    ).toBeTruthy();
  });

  it('shows the harness picker when only the solver role is selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));

    expect(screen.getByTestId('join-flow-solver-fields')).toBeTruthy();
    expect(screen.queryByTestId('join-flow-evaluator-info')).toBeNull();
  });

  it('shows both the harness picker and an evaluator binding note when both roles are selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByLabelText('Evaluator'));

    expect(screen.getByTestId('join-flow-solver-fields')).toBeTruthy();
    expect(screen.getByTestId('join-flow-evaluator-info')).toBeTruthy();
  });

  it('disables the submit button when no roles are selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe('JoinFlow — submission', () => {
  it('calls api.operator.join with the chosen roles + solver fields and navigates on success', async () => {
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    // Wait for the catalog query to populate the harness select default.
    await waitFor(() => expect(apiMock.getSolverNets).toHaveBeenCalled());

    // Toggle the bundled plugin on.
    fireEvent.click(screen.getByLabelText(/plugin: jinn-prediction-plugin/i));

    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
    expect(apiMock.operatorJoin).toHaveBeenCalledWith(
      'bafybeiaaa',
      expect.objectContaining({
        name: 'Prediction Markets',
        roles: ['solver'],
        harness: 'claude-code-learner',
        plugins: ['jinn-prediction-plugin'],
      }),
    );
    await waitFor(() =>
      expect(nav.history.at(-1)).toBe('/operator#solvernets'),
    );
  });

  it('omits solver-only fields when only evaluator is selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Evaluator'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
    const callArgs = apiMock.operatorJoin.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.roles).toEqual(['evaluator']);
    expect(callArgs.harness).toBeUndefined();
    expect(callArgs.model).toBeUndefined();
    expect(callArgs.plugins).toBeUndefined();
  });

  it('surfaces a submit error and does not navigate', async () => {
    apiMock.operatorJoin.mockRejectedValue(new Error('config_write_failed'));
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('join-flow-submit-error')).toBeTruthy(),
    );
    expect(screen.getByTestId('join-flow-submit-error').textContent).toMatch(
      /config_write_failed/,
    );
    // Nav stayed put — no successful redirect.
    expect(nav.history.at(-1)).toBe('/operator/join/bafybeiaaa');
  });

  it('cancel button navigates back to /operator#solvernets', async () => {
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('join-flow-cancel'));

    expect(nav.history.at(-1)).toBe('/operator#solvernets');
  });
});
