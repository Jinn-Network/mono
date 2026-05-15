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
  hermesDoctor: vi.fn(),
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
    hermesDoctor: () => apiMock.hermesDoctor(),
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
      contract: { id: 'prediction', version: 'v1' },
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
  apiMock.hermesDoctor.mockReset();

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

  it('formats tiny manifest prices as gwei', async () => {
    apiMock.getManifest.mockResolvedValue({
      manifest: {
        ...baseManifest,
        solutionPriceWei: '10000000000',
        verdictPriceWei: '5000000000',
      },
      lifecycle: {
        status: 'launched' as const,
        statusUpdatedAt: '2026-05-05T00:00:00Z',
        sourceBlock: 1,
      },
    });

    wrap(<JoinFlow />);

    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );
    expect(screen.getByText('10 gwei')).toBeTruthy();
    expect(screen.getByText('5 gwei')).toBeTruthy();
    expect(screen.queryByText(/e-/i)).toBeNull();
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

describe('JoinFlow — harness options', () => {
  it('renders Hermes Agent as a selectable harness option when catalog includes it', async () => {
    apiMock.getSolverNets.mockResolvedValue({
      ...baseCatalog,
      nets: [
        {
          ...baseCatalog.nets[0]!,
          compatibleHarnesses: [
            { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'hermes-agent', version: '0.1.0', supportsRoles: ['solving' as const] },
          ],
        },
      ],
    });

    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText('Solver'));

    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toContain('Hermes Agent 0.1.0'),
    );
    expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toContain('Claude Code 0.1.0');
    expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toContain('Codex 0.1.0');
  });

  it('shows the Hermes install description when Hermes Agent is selected', async () => {
    apiMock.getSolverNets.mockResolvedValue({
      ...baseCatalog,
      nets: [
        {
          ...baseCatalog.nets[0]!,
          compatibleHarnesses: [
            { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'hermes-agent', version: '0.1.0', supportsRoles: ['solving' as const] },
          ],
        },
      ],
    });

    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText('Solver'));

    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(harnessSelect.options).some((o) => o.value === 'hermes-agent')).toBe(true),
    );

    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });

    await waitFor(() =>
      expect(screen.getByTestId('join-harness-hermes-description')).toBeTruthy(),
    );
    expect(screen.getByTestId('join-harness-hermes-description').textContent).toMatch(
      /requires separate install/i,
    );
    expect(screen.getByTestId('join-harness-hermes-description').textContent).toMatch(
      /Nous Research/,
    );
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

  it('defaults SWE solver joins to Claude Code and default-includes the SWE runtime', async () => {
    apiMock.getManifest.mockResolvedValue({
      manifest: {
        ...baseManifest,
        name: 'SWE-rebench v2',
        contract: {
          ...baseManifest.contract,
          id: 'swe-rebench-v2',
          version: 'v1',
        },
      },
      lifecycle: {
        status: 'launched' as const,
        statusUpdatedAt: '2026-05-05T00:00:00Z',
        sourceBlock: 1,
      },
    });
    apiMock.getSolverNets.mockResolvedValue({
      ...baseCatalog,
      nets: [
        {
          ...baseCatalog.nets[0]!,
          name: 'swe-rebench-v2',
          contract: { id: 'swe-rebench-v2', version: 'v1' },
          compatibleHarnesses: [
            { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
          ],
          compatiblePlugins: [
            { name: 'swe-rebench-v2-runtime', version: '0.1.0', source: 'bundled' },
          ],
        },
      ],
    });

    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));

    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() => expect(harnessSelect.value).toBe('claude-code'));
    expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toEqual([
      'Claude Code 0.1.0',
      'Codex 0.1.0',
    ]);

    const modelSelect = screen.getByTestId('join-model-select') as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((o) => o.value);
    expect(modelSelect.value).toBe('claude-haiku-4-5-20251001');
    expect(optionValues).toContain('claude-sonnet-4-6');
    expect(optionValues).not.toContain('gpt-5.4-mini');

    const chips = screen.getAllByTestId('join-plugin-option-chip');
    expect(chips.some((chip) => chip.textContent?.match(/network tools/i))).toBe(true);
    expect(chips.some((chip) => chip.textContent?.match(/learner/i))).toBe(true);
    expect(
      chips.some(
        (chip) =>
          chip.getAttribute('data-plugin') === 'swe-rebench-v2-runtime' &&
          chip.textContent?.match(/default/i),
      ),
    ).toBe(true);
    expect(screen.queryByTestId('join-plugin-option')).toBeNull();

    fireEvent.click(screen.getByTestId('join-plugin-option-trigger'));
    let pluginRows = screen.queryAllByTestId('join-plugin-option');
    expect(pluginRows.some((row) => row.getAttribute('data-plugin') === 'network-tools')).toBe(false);
    expect(pluginRows.some((row) => row.getAttribute('data-plugin') === 'claude-code-learner')).toBe(false);
    expect(pluginRows.some((row) => row.getAttribute('data-plugin') === 'swe-rebench-v2-runtime')).toBe(false);

    fireEvent.change(screen.getByTestId('join-plugin-search'), {
      target: { value: 'swe' },
    });
    pluginRows = screen.queryAllByTestId('join-plugin-option');
    expect(pluginRows).toHaveLength(0);
  });

  it('allows removing a default plugin after warning and keeps it available to re-add', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));

    const removeNetwork = screen
      .getAllByTestId('join-plugin-option-remove')
      .find((button) => button.getAttribute('data-plugin') === 'network-tools')!;
    fireEvent.click(removeNetwork);
    expect(screen.getByTestId('join-plugin-option-default-warning').textContent).toMatch(
      /default operator baseline/i,
    );
    fireEvent.click(screen.getByTestId('join-plugin-option-default-warning-confirm'));

    expect(
      screen
        .getAllByTestId('join-plugin-option-chip')
        .some((chip) => chip.getAttribute('data-plugin') === 'network-tools'),
    ).toBe(false);

    fireEvent.click(screen.getByTestId('join-plugin-option-trigger'));
    const pluginRows = screen.getAllByTestId('join-plugin-option');
    expect(pluginRows.find((row) => row.getAttribute('data-plugin') === 'network-tools')).toBeTruthy();
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

    // Add the recommended SolverNet plugin from the searchable picker.
    fireEvent.click(screen.getByTestId('join-plugin-option-trigger'));
    fireEvent.click(
      screen
        .getAllByTestId('join-plugin-option')
        .find((row) => row.getAttribute('data-plugin') === 'jinn-prediction-plugin')!,
    );

    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
    expect(apiMock.operatorJoin).toHaveBeenCalledWith(
      'bafybeiaaa',
      expect.objectContaining({
        name: 'Prediction Markets',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: ['bundled:jinn-prediction-plugin'],
        disabledDefaultPlugins: [],
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
    expect(callArgs.contract).toEqual({ id: 'prediction', version: 'v1' });
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

describe('JoinFlow — Hermes Agent precheck panel', () => {
  /** Catalog with hermes-agent listed as compatible so it appears in the select. */
  const hermesCompatibleCatalog = {
    ...baseCatalog,
    nets: [
      {
        ...baseCatalog.nets[0]!,
        compatibleHarnesses: [
          { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
          { name: 'hermes-agent', version: '0.1.0', supportsRoles: ['solving' as const] },
        ],
      },
    ],
  };

  async function setupHermesSelected(): Promise<void> {
    apiMock.getSolverNets.mockResolvedValue(hermesCompatibleCatalog);
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    // Select solver role so the harness picker shows.
    fireEvent.click(screen.getByLabelText('Solver'));

    // Wait for the harness select to be populated with hermes-agent.
    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(harnessSelect.options).some((o) => o.value === 'hermes-agent')).toBe(true),
    );

    // Select hermes-agent.
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });
    await waitFor(() => expect(harnessSelect.value).toBe('hermes-agent'));
  }

  it('shows the not-installed panel when hermesDoctor returns installed:false', async () => {
    apiMock.hermesDoctor.mockResolvedValue({ installed: false, exitCode: null, stdout: '', stderr: '' });

    await setupHermesSelected();

    // Click submit — should fire precheck instead of join.
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('hermes-precheck-not-installed')).toBeTruthy(),
    );
    expect(screen.getByTestId('hermes-precheck-not-installed').textContent).toMatch(/not installed/i);
    // The curl install command should be visible.
    expect(screen.getByTestId('hermes-precheck-not-installed').textContent).toMatch(/curl/);
    // The join mutation should NOT have fired.
    expect(apiMock.operatorJoin).not.toHaveBeenCalled();
  });

  it('shows the config-issue panel when hermesDoctor returns exitCode:1', async () => {
    const stderrMsg = 'error: no provider configured';
    apiMock.hermesDoctor.mockResolvedValue({
      installed: true,
      exitCode: 1,
      stdout: '',
      stderr: stderrMsg,
    });

    await setupHermesSelected();

    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('hermes-precheck-config-issue')).toBeTruthy(),
    );
    expect(screen.getByTestId('hermes-precheck-config-issue').textContent).toMatch(stderrMsg);
    expect(apiMock.operatorJoin).not.toHaveBeenCalled();
  });

  it('proceeds to join when hermesDoctor returns exitCode:0', async () => {
    apiMock.hermesDoctor.mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'all checks passed',
      stderr: '',
    });
    apiMock.operatorJoin.mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
      config: { manifestCid: 'bafybeiaaa', roles: ['solver'] },
    });

    await setupHermesSelected();

    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
    expect(apiMock.operatorJoin).toHaveBeenCalledWith(
      'bafybeiaaa',
      expect.objectContaining({ harness: 'hermes-agent', roles: ['solver'] }),
    );
  });

  it('retry precheck button re-runs the doctor check', async () => {
    // First call: not installed; second call: ok.
    apiMock.hermesDoctor
      .mockResolvedValueOnce({ installed: false, exitCode: null, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ installed: true, exitCode: 0, stdout: '', stderr: '' });
    apiMock.operatorJoin.mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
      config: { manifestCid: 'bafybeiaaa', roles: ['solver'] },
    });

    await setupHermesSelected();
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('hermes-precheck-not-installed')).toBeTruthy(),
    );

    // Click retry.
    fireEvent.click(screen.getByTestId('hermes-precheck-retry'));

    // After retry with exitCode:0 the join should proceed.
    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
  });

  it('cancel button on the precheck panel hides the panel and does not join', async () => {
    apiMock.hermesDoctor.mockResolvedValue({ installed: false, exitCode: null, stdout: '', stderr: '' });

    await setupHermesSelected();
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('hermes-precheck-not-installed')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('hermes-precheck-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('hermes-precheck-not-installed')).toBeNull(),
    );
    expect(apiMock.operatorJoin).not.toHaveBeenCalled();
    // The harness select should still be visible.
    expect(screen.getByTestId('join-flow-solver-fields')).toBeTruthy();
  });

  it('shows the network-error panel when hermesDoctor rejects (does NOT fall through to install)', async () => {
    apiMock.hermesDoctor.mockRejectedValue(new Error('Network error: failed to fetch /api/hermes/doctor'));

    await setupHermesSelected();
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('hermes-precheck-network-error')).toBeTruthy(),
    );
    expect(screen.getByTestId('hermes-precheck-network-error').textContent).toMatch(/Could not reach the daemon/i);
    // Critically, we must NOT show the install command (operator would otherwise
    // reinstall a Hermes that is already there when the daemon is just down).
    expect(screen.queryByTestId('hermes-precheck-not-installed')).toBeNull();
    expect(apiMock.operatorJoin).not.toHaveBeenCalled();
  });
});
