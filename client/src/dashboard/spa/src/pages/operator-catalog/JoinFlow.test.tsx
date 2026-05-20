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
  harnessReadiness: vi.fn(),
  restartDaemon: vi.fn(),
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
    harnessReadiness: (name: string) => apiMock.harnessReadiness(name),
    restartDaemon: () => apiMock.restartDaemon(),
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
  apiMock.harnessReadiness.mockReset();
  apiMock.restartDaemon.mockReset();

  // Default: every probed harness reports ready. Tests that exercise the
  // not-ready path override this per harness name.
  apiMock.harnessReadiness.mockImplementation(async (name: string) => ({
    harnessName: name,
    manifestCids: [],
    ready: true,
  }));

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
  apiMock.restartDaemon.mockResolvedValue({ ok: true, scheduled: true });
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

  it('shows the Hermes description when Hermes Agent is selected', async () => {
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
      /Nous Research/,
    );
    expect(screen.getByTestId('join-harness-hermes-description').textContent).toMatch(
      /Built-in learning loop/,
    );
  });

  it('selecting Claude Code in the dropdown sticks even when the catalog default is Hermes (issue #329)', async () => {
    // Issue #329 regression. Production SWE-rebench v2 catalog
    // (`client/src/main.ts`) lists Hermes first; selecting Claude Code from
    // the dropdown silently reverted to Hermes on every render because a
    // render-time `setForm` was bouncing form.harness back to the catalog
    // default whenever it equalled the seed `claude-code`. Cover the full
    // sequence: catalog default Hermes -> operator picks Claude Code -> value
    // sticks across re-renders -> submit carries claude-code.
    apiMock.getSolverNets.mockResolvedValue({
      ...baseCatalog,
      nets: [
        {
          ...baseCatalog.nets[0]!,
          compatibleHarnesses: [
            { name: 'hermes-agent', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
            { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
          ],
        },
      ],
    });

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    // Catalog-arrival effect picks Hermes as the seed.
    await waitFor(() => expect(harnessSelect.value).toBe('hermes-agent'));

    // Operator selects Claude Code.
    fireEvent.change(harnessSelect, { target: { value: 'claude-code' } });

    // The pick must stick — not silently revert to Hermes on re-render.
    await waitFor(() => expect(harnessSelect.value).toBe('claude-code'));
    // Force several re-renders (toggle Evaluator on and off) to exercise the
    // catalog-arrival effect's dependency tracking — Claude Code must remain.
    fireEvent.click(screen.getByLabelText('Evaluator'));
    fireEvent.click(screen.getByLabelText('Evaluator'));
    expect(harnessSelect.value).toBe('claude-code');

    // Submit carries the operator's choice.
    fireEvent.click(screen.getByTestId('join-flow-submit'));
    await waitFor(() => expect(apiMock.operatorJoin).toHaveBeenCalled());
    expect(apiMock.operatorJoin).toHaveBeenCalledWith(
      'bafybeiaaa',
      expect.objectContaining({ harness: 'claude-code', roles: ['solver'] }),
    );
  });

  it('drops claude-code-learner from default plugins when Hermes Agent is selected', async () => {
    // Hermes owns its own learning loop (skill self-improvement, memory
    // curation, FTS5 session search — see harnesses/impls/hermes-agent/
    // harness.ts), so the Jinn-side `claude-code-learner` plugin must not
    // be force-enabled on Hermes joins. Claude Code keeps it by default.
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
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(harnessSelect.options).some((o) => o.value === 'hermes-agent')).toBe(true),
    );

    // Claude Code: learner is in the default chip set. The harness select
    // exposes canonical names — `claude-code-learner` is aliased to
    // `claude-code` by canonicalHarnessName.
    fireEvent.change(harnessSelect, { target: { value: 'claude-code' } });
    await waitFor(() => {
      const chips = Array.from(
        document.querySelectorAll('[data-testid="join-plugin-option-chip"]'),
      ) as HTMLElement[];
      expect(chips.some((c) => c.getAttribute('data-plugin') === 'claude-code-learner')).toBe(true);
    });

    // Hermes: learner chip is gone.
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });
    // Wait for the harness change to propagate (hermes description appears).
    await waitFor(() =>
      expect(screen.getByTestId('join-harness-hermes-description')).toBeTruthy(),
    );
    const chips = Array.from(
      document.querySelectorAll('[data-testid="join-plugin-option-chip"]'),
    ) as HTMLElement[];
    const chipPlugins = chips.map((c) => c.getAttribute('data-plugin'));
    expect(chipPlugins).not.toContain('claude-code-learner');
    expect(chipPlugins).toContain('network-tools');
  });
});

describe('JoinFlow — per-harness readiness gate (#332)', () => {
  /** Catalog with Claude Code + Codex, both compatible. */
  const twoHarnessCatalog = {
    ...baseCatalog,
    nets: [
      {
        ...baseCatalog.nets[0]!,
        compatibleHarnesses: [
          { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
          { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] },
        ],
      },
    ],
  };

  it('disables the harness option for a not-ready harness', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    apiMock.harnessReadiness.mockImplementation(async (name: string) => {
      if (name === 'codex') {
        return {
          harnessName: 'codex',
          manifestCids: [],
          ready: false,
          reason: 'codex CLI not installed',
          nextStep: { description: 'Install Codex CLI', cli: 'npm i -g @openai/codex' },
        };
      }
      return { harnessName: name, manifestCids: [], ready: true };
    });

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    await waitFor(() => {
      const codexOption = screen
        .getAllByTestId('join-harness-option')
        .find((o) => o.getAttribute('data-harness') === 'codex') as HTMLOptionElement;
      expect(codexOption.disabled).toBe(true);
    });
    const codexOption = screen
      .getAllByTestId('join-harness-option')
      .find((o) => o.getAttribute('data-harness') === 'codex') as HTMLOptionElement;
    expect(codexOption.textContent).toMatch(/setup required/i);

    // Claude Code is ready — its option stays selectable.
    const claudeOption = screen
      .getAllByTestId('join-harness-option')
      .find((o) => o.getAttribute('data-harness') === 'claude-code') as HTMLOptionElement;
    expect(claudeOption.disabled).toBe(false);
  });

  it('shows the nextStep caption when the selected harness is not ready', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    // Claude Code (the default selection) is not ready.
    apiMock.harnessReadiness.mockImplementation(async (name: string) => {
      if (name === 'claude-code') {
        return {
          harnessName: 'claude-code',
          manifestCids: [],
          ready: false,
          reason: 'not signed in',
          nextStep: { description: 'Sign in to Claude Code', cli: 'claude login' },
        };
      }
      return { harnessName: name, manifestCids: [], ready: true };
    });

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    await waitFor(() =>
      expect(screen.getByTestId('join-harness-not-ready')).toBeTruthy(),
    );
    const banner = screen.getByTestId('join-harness-not-ready');
    expect(banner.textContent).toMatch(/not ready/i);
    expect(banner.textContent).toMatch(/not signed in/);
    expect(screen.getByTestId('join-harness-not-ready-next-step').textContent).toMatch(
      /Sign in to Claude Code/,
    );
    expect(screen.getByTestId('join-harness-not-ready-next-step').textContent).toMatch(
      /claude login/,
    );
  });

  it('gates Save & Join when the selected solver harness is not ready', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    apiMock.harnessReadiness.mockImplementation(async (name: string) => {
      if (name === 'claude-code') {
        return {
          harnessName: 'claude-code',
          manifestCids: [],
          ready: false,
          reason: 'not signed in',
          nextStep: { description: 'Sign in to Claude Code' },
        };
      }
      return { harnessName: name, manifestCids: [], ready: true };
    });

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    // Default harness (claude-code) is not ready — submit must be disabled.
    await waitFor(() => {
      const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });
  });

  it('does NOT gate Save & Join when the selected harness is ready', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    // Default mock: all ready.
    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    await waitFor(() => expect(apiMock.harnessReadiness).toHaveBeenCalled());
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByTestId('join-harness-not-ready')).toBeNull();
  });

  it('does NOT gate Save & Join on harness readiness when only evaluator is selected', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    // Even if a solver harness probe came back not-ready, the evaluator-only
    // path binds harness from the manifest and must not be readiness-gated.
    apiMock.harnessReadiness.mockImplementation(async (name: string) => ({
      harnessName: name,
      manifestCids: [],
      ready: false,
      reason: 'not signed in',
    }));

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Evaluator'));

    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    // The solver-only not-ready banner is not rendered without solver fields.
    expect(screen.queryByTestId('join-harness-not-ready')).toBeNull();
  });

  it('does not crash when a harness is absent from the readiness snapshot (404)', async () => {
    apiMock.getSolverNets.mockResolvedValue(twoHarnessCatalog);
    apiMock.harnessReadiness.mockImplementation(async (_name: string) => {
      const err = new Error('404 Not Found') as Error & { code?: string };
      err.code = 'harness_not_found';
      throw err;
    });

    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));

    await waitFor(() => expect(apiMock.harnessReadiness).toHaveBeenCalled());
    // Unknown readiness → not blocked, no not-ready banner, options enabled.
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByTestId('join-harness-not-ready')).toBeNull();
    const options = screen.getAllByTestId('join-harness-option') as HTMLOptionElement[];
    expect(options.every((o) => !o.disabled)).toBe(true);
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
  it('calls api.operator.join with the chosen roles + solver fields and shows the success affordance', async () => {
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
    // #333: a successful join shows an explicit success state ON the join
    // page — it must NOT silently redirect to /operator.
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-success')).toBeTruthy(),
    );
    expect(nav.history.at(-1)).toBe('/operator/join/bafybeiaaa');
  });

  it('renders a success card naming the joined SolverNet and a restart hint (#333)', async () => {
    apiMock.operatorJoin.mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
      config: {
        manifestCid: 'bafybeiaaa',
        name: 'Prediction Markets',
        roles: ['solver'],
      },
    });
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('join-flow-success-card')).toBeTruthy(),
    );
    expect(screen.getByTestId('join-flow-success-name').textContent).toMatch(
      /Prediction Markets/,
    );
    expect(screen.getByTestId('join-flow-success-restart')).toBeTruthy();
    // The form is gone — the operator is on a confirmation, not the picker.
    expect(screen.queryByTestId('join-flow-submit')).toBeNull();
  });

  it('success-card CTA navigates into the joined SolverNet (#333)', async () => {
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('join-flow-success-view')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('join-flow-success-view'));
    expect(nav.history.at(-1)).toBe('/operator#solvernets/bafybeiaaa');
  });

  it('success-card restart button restarts the daemon and goes to /overview (#328)', async () => {
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('join-flow-success-restart-button'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('join-flow-success-restart-button'));

    await waitFor(() => expect(apiMock.restartDaemon).toHaveBeenCalled());
    await waitFor(() => expect(nav.history.at(-1)).toBe('/overview'));
  });

  it('success-card restart button surfaces an error and stays put on failure (#328)', async () => {
    apiMock.restartDaemon.mockResolvedValue({ ok: false });
    const { nav } = wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByTestId('join-flow-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('join-flow-success-restart-button'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('join-flow-success-restart-button'));

    await waitFor(() =>
      expect(
        screen.getByTestId('join-flow-success-restart-error'),
      ).toBeTruthy(),
    );
    // Restart failed — the operator was not redirected away.
    expect(nav.history.at(-1)).toBe('/operator/join/bafybeiaaa');
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

    // Hermes default is Opus 4.7 — above the $1/task cost gate (Issue
    // #331). Acknowledge it so the submit button isn't gated; these
    // tests are exercising the precheck path, not the cost gate.
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-cost-confirmation')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('join-flow-cost-confirmation-checkbox'));
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

  // Cost-protection P0 tests live in the following describe block, then the
  // remaining Hermes precheck cases continue below.

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

describe('JoinFlow — cost surfacing + confirmation gate (Issue #331 P0)', () => {
  /**
   * Catalog with Hermes + Claude Code, both compatible. The default solver
   * harness is the first compatible — Claude Code — so the cost surface
   * for that path renders the subscription reassurance. Switching to
   * Hermes + Opus 4.7 puts us in the high-cost band; switching to
   * Hermes + DeepSeek V4 Flash stays under the $1 threshold.
   */
  const mixedHarnessCatalog = {
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

  async function setupSolverWithMixedHarnesses(): Promise<HTMLSelectElement> {
    apiMock.getSolverNets.mockResolvedValue(mixedHarnessCatalog);
    wrap(<JoinFlow />);
    await waitFor(() => expect(screen.getByTestId('join-flow-summary')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Solver'));
    const harnessSelect = screen.getByTestId('join-harness-select') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(harnessSelect.options).some((o) => o.value === 'hermes-agent')).toBe(true),
    );
    return harnessSelect;
  }

  it('renders the subscription reassurance row and NO confirmation gate for Claude Code', async () => {
    const harnessSelect = await setupSolverWithMixedHarnesses();
    fireEvent.change(harnessSelect, { target: { value: 'claude-code' } });

    await waitFor(() =>
      expect(screen.getByTestId('join-flow-cost-subscription')).toBeTruthy(),
    );
    expect(screen.getByTestId('join-flow-cost-subscription').textContent).toMatch(
      /subscription/i,
    );
    // No confirmation gate, no high-cost panel.
    expect(screen.queryByTestId('join-flow-cost-confirmation')).toBeNull();
    expect(screen.queryByTestId('join-flow-cost-panel')).toBeNull();

    // The submit button should remain enabled once a role is picked.
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('shows the cost panel and the $1/task warning for Hermes + Opus 4.7', async () => {
    const harnessSelect = await setupSolverWithMixedHarnesses();
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });

    // Hermes default is anthropic/claude-opus-4.7 — above the $1/task gate.
    await waitFor(() => expect(screen.getByTestId('join-flow-cost-panel')).toBeTruthy());
    const panel = screen.getByTestId('join-flow-cost-panel');
    expect(panel.getAttribute('data-cost-high-cost')).toBe('true');
    expect(panel.getAttribute('data-cost-mode')).toBe('paid-api');
    expect(screen.getByTestId('join-flow-cost-amount').textContent).toMatch(/\$2\.25/);
    expect(screen.getByTestId('join-flow-cost-warning')).toBeTruthy();
    expect(screen.getByTestId('join-flow-cost-confirmation')).toBeTruthy();
  });

  it('disables the Save & Join button until the high-cost confirmation is checked', async () => {
    const harnessSelect = await setupSolverWithMixedHarnesses();
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });

    await waitFor(() => expect(screen.getByTestId('join-flow-cost-confirmation')).toBeTruthy());
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const checkbox = screen.getByTestId(
      'join-flow-cost-confirmation-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it('does NOT show the confirmation gate for Hermes + DeepSeek V4 Flash (sub-$1 model)', async () => {
    const harnessSelect = await setupSolverWithMixedHarnesses();
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });

    // Switch to a low-cost model.
    await waitFor(() => expect(screen.getByTestId('join-model-select')).toBeTruthy());
    const modelSelect = screen.getByTestId('join-model-select') as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek/deepseek-v4-flash' } });

    // Panel still shows, but the warning + confirmation are gone.
    await waitFor(() => expect(screen.getByTestId('join-flow-cost-panel')).toBeTruthy());
    expect(screen.getByTestId('join-flow-cost-panel').getAttribute('data-cost-high-cost')).toBe('false');
    expect(screen.queryByTestId('join-flow-cost-warning')).toBeNull();
    expect(screen.queryByTestId('join-flow-cost-confirmation')).toBeNull();

    // And the submit button is enabled (no gate).
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('resets the confirmation when the model is swapped back to a low-cost model', async () => {
    const harnessSelect = await setupSolverWithMixedHarnesses();
    fireEvent.change(harnessSelect, { target: { value: 'hermes-agent' } });

    // Acknowledge Opus 4.7.
    await waitFor(() => expect(screen.getByTestId('join-flow-cost-confirmation')).toBeTruthy());
    fireEvent.click(screen.getByTestId('join-flow-cost-confirmation-checkbox'));

    // Switch to a cheap model — confirmation goes away.
    const modelSelect = screen.getByTestId('join-model-select') as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek/deepseek-v4-flash' } });
    await waitFor(() => expect(screen.queryByTestId('join-flow-cost-confirmation')).toBeNull());

    // Switch back to Opus — confirmation reappears and the prior tick must
    // NOT have persisted (operator must re-confirm).
    fireEvent.change(modelSelect, { target: { value: 'anthropic/claude-opus-4.7' } });
    await waitFor(() => expect(screen.getByTestId('join-flow-cost-confirmation')).toBeTruthy());
    const checkbox = screen.getByTestId('join-flow-cost-confirmation-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const submit = screen.getByTestId('join-flow-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe('JoinFlow — inline decision-context help (#334)', () => {
  it('renders a help trigger next to the Roles label', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    expect(screen.getByRole('button', { name: 'Roles help' })).toBeTruthy();
  });

  it('expands Roles help with solver-vs-evaluator trade-off copy', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Roles help' }));

    const panels = screen.getAllByTestId('inline-help-panel');
    expect(panels.length).toBeGreaterThan(0);
    const rolesPanel = panels.find((p) =>
      /spending role/i.test(p.textContent ?? ''),
    );
    expect(rolesPanel).toBeTruthy();
    expect(rolesPanel?.textContent).toMatch(/evaluator/i);
  });

  it('shows Harness, Model and Plugins help triggers once the solver role is selected', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));

    expect(screen.getByRole('button', { name: 'Harness help' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model help' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plugins help' })).toBeTruthy();
  });

  it('Harness help explains harnesses need credentials for one, not both', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByRole('button', { name: 'Harness help' }));

    const panels = screen.getAllByTestId('inline-help-panel');
    const harnessPanel = panels.find((p) =>
      /credentials for one harness/i.test(p.textContent ?? ''),
    );
    expect(harnessPanel).toBeTruthy();
  });

  it('Plugins help tells first-run operators they can skip the section', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    fireEvent.click(screen.getByRole('button', { name: 'Plugins help' }));

    const panels = screen.getAllByTestId('inline-help-panel');
    const pluginsPanel = panels.find((p) =>
      /do not need to touch/i.test(p.textContent ?? ''),
    );
    expect(pluginsPanel).toBeTruthy();
  });

  it('Evaluator-info help explains the empty model selector is by design', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText('Evaluator'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Evaluator configuration help' }),
    );

    const panels = screen.getAllByTestId('inline-help-panel');
    const evalPanel = panels.find((p) =>
      /by design/i.test(p.textContent ?? ''),
    );
    expect(evalPanel).toBeTruthy();
    expect(evalPanel?.textContent).toMatch(/same evaluation function/i);
  });

  it('inline help links out to the join-form-context doc', async () => {
    wrap(<JoinFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('join-flow-summary')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Roles help' }));

    const link = screen.getByTestId('inline-help-doc-link');
    // Assert the full path — a filename-only match let a stale
    // `cargo/client/docs/...` segment (which 404s) slip through (#328).
    expect(link.getAttribute('href')).toMatch(
      /\/client\/docs\/operator\/join-form-context\.md/,
    );
  });
});
