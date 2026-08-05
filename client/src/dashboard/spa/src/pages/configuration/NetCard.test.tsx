import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NetCard } from './NetCard.js';
import type { SolverNetManifestV1 } from '../../../../../api/contract/index.js';

const apiMock = vi.hoisted(() => ({
  updateSolverNet: vi.fn(),
  operatorLeave: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  api: {
    updateSolverNet: apiMock.updateSolverNet,
    operator: {
      leave: (cid: string) => apiMock.operatorLeave(cid),
    },
  },
}));

const baseCatalog = {
  name: 'prediction',
  description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
  contract: { id: 'prediction', version: 'v1' },
  state: 'live' as const,
  supportedRoles: ['solving' as const, 'evaluating' as const],
  compatibleHarnesses: [
    { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const, 'evaluating' as const] },
  ],
  compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
};

describe('NetCard', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    apiMock.updateSolverNet.mockClear();
    apiMock.updateSolverNet.mockResolvedValue({
      ok: true,
      restartRequired: false,
      name: 'prediction',
      config: {},
    });
  });

  it('renders name, description, and Available state when disabled', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: false, roles: ['solving'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText('prediction')).toBeTruthy();
    expect(screen.getByText(/forecast resolved outcomes/i)).toBeTruthy();
    expect(screen.getByText(/available/i)).toBeTruthy();
  });

  it('expands the body when enabled and shows the Solver checkbox active', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: true, roles: ['solving'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: ['jinn-prediction-plugin'] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText(/live/i)).toBeTruthy();
    const solver = screen.getByLabelText('Solver') as HTMLInputElement;
    const evaluator = screen.getByLabelText('Evaluator') as HTMLInputElement;
    expect(solver.checked).toBe(true);
    expect(evaluator.checked).toBe(false);
  });

  it('renders both checkboxes checked when both roles are configured', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving', 'evaluating'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    const solver = screen.getByLabelText('Solver') as HTMLInputElement;
    const evaluator = screen.getByLabelText('Evaluator') as HTMLInputElement;
    expect(solver.checked).toBe(true);
    expect(evaluator.checked).toBe(true);
  });

  it('persists both roles when the operator enables Evaluator alongside Solver', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          modelExplicit: false,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Evaluator'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    // Order should be canonical (catalog ordering: ['solving', 'evaluating']).
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      roles: ['solving', 'evaluating'],
    }));
  });

  it('disables save and surfaces validation when both checkboxes are unchecked', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Solver'));
    expect(screen.getByRole('alert').textContent).toMatch(/at least one role required/i);
    const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('does not persist the displayed fallback model when saving another field', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: false,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          modelExplicit: false,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /enable prediction/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.not.objectContaining({
      model: expect.any(String),
    }));
  });

  it('renders the prediction orb sigil for catalog.name="prediction"', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: false, roles: ['solving'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    const sigil = screen.getByTestId('solver-net-sigil');
    expect(sigil).toBeTruthy();
    expect(sigil.getAttribute('data-sigil-name')).toBe('prediction');
    expect(screen.getByTestId('solver-net-sigil-prediction')).toBeTruthy();
  });

  it('renders the fallback sigil for unknown SolverNet names', () => {
    render(
      <NetCard
        catalog={{ ...baseCatalog, name: 'mystery-net' }}
        config={{ enabled: false, roles: ['solving'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    const sigil = screen.getByTestId('solver-net-sigil');
    expect(sigil).toBeTruthy();
    expect(sigil.getAttribute('data-sigil-name')).toBe('mystery-net');
    expect(screen.getByTestId('solver-net-sigil-fallback')).toBeTruthy();
  });

  it('persists the model when the operator edits the fallback value', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          modelExplicit: false,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      model: 'claude-sonnet-4-6',
    }));
  });

  it('renders an unknown model as a Custom option alongside the canonical tiers, and switching to Sonnet stages a dirty save', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-sonnet-4-5-20250929',
          modelExplicit: true,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    const optionLabels = Array.from(select.options).map((o) => o.textContent);

    expect(optionValues).toContain('claude-haiku-4-5-20251001');
    expect(optionValues).toContain('claude-sonnet-4-6');
    expect(optionValues).toContain('claude-opus-4-7');
    expect(optionValues).toContain('claude-sonnet-4-5-20250929');
    expect(optionLabels).toContain('Haiku');
    expect(optionLabels).toContain('Sonnet');
    expect(optionLabels).toContain('Opus');
    expect(optionLabels).toContain('Custom (claude-sonnet-4-5-20250929)');

    // No dirty banner yet — select reflects the stored value.
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();

    fireEvent.change(select, { target: { value: 'claude-sonnet-4-6' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      model: 'claude-sonnet-4-6',
    }));
  });

  it('shows Codex model choices when the selected harness is codex-code-learner', () => {
    render(
      <NetCard
        catalog={{
          ...baseCatalog,
          compatibleHarnesses: [
            { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving'] },
            { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] },
          ],
        }}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'codex-code-learner',
          model: 'gpt-5.4-mini',
          modelExplicit: true,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    const optionLabels = Array.from(select.options).map((o) => o.textContent);

    expect(optionValues).toContain('gpt-5.4-mini');
    expect(optionValues).toContain('gpt-5.5');
    expect(optionLabels).toContain('GPT-5.4 Mini');
    expect(optionLabels).toContain('GPT-5.5');
    expect(optionValues).not.toContain('claude-haiku-4-5-20251001');
  });

  it('adds a plugin from the picker, becomes dirty, and persists on save', async () => {
    const multiPluginCatalog = {
      ...baseCatalog,
      compatiblePlugins: [
        { name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' },
        { name: 'network-tools', version: '0.2.0', source: 'bundled' },
      ],
    };
    render(
      <NetCard
        catalog={multiPluginCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: ['jinn-prediction-plugin'],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    // No save button visible while clean.
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Add plugin'), {
      target: { value: 'network-tools' },
    });

    // Dirty: save button appears.
    const saveBtn = await screen.findByRole('button', { name: /save changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      plugins: ['jinn-prediction-plugin', 'network-tools'],
    }));
  });

  it('removes a plugin from the row, becomes dirty, and persists on save', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: ['jinn-prediction-plugin'],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /remove jinn-prediction-plugin/i }));

    const saveBtn = await screen.findByRole('button', { name: /save changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      plugins: [],
    }));
  });

  it('renders the empty-catalog hint when no plugins are compatible', () => {
    const emptyCatalog = { ...baseCatalog, compatiblePlugins: [] };
    render(
      <NetCard
        catalog={emptyCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText(/no plugins available for this solvernet/i)).toBeTruthy();
    expect(screen.queryByLabelText('Add plugin')).toBeNull();
  });
});

// ── NetCard manifest-keyed (joined) variant (Task 21) ──────────────────────

const baseManifest: SolverNetManifestV1 = {
  schemaVersion: 'solvernet.manifest.v1',
  solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
  network: 'base-sepolia',
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
      mode: 'parallel',
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
  openRoles: ['solver', 'evaluator'],
  createdAt: '2026-05-05T00:00:00Z',
  launchedAt: '2026-05-05T00:01:00Z',
  signature: {
    alg: 'eip-191',
    signer: '0x1111111111111111111111111111111111111111',
    value: '0xdeadbeef',
  },
};

describe('NetCard — manifest-keyed (joined) variant', () => {
  beforeEach(() => {
    apiMock.operatorLeave.mockClear();
    apiMock.operatorLeave.mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the manifest summary with current roles, harness, and Joined state', () => {
    render(
      <NetCard
        manifestCid="bafybeiaaa"
        manifest={baseManifest}
        joined={{
          roles: ['solver'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: ['jinn-prediction-plugin'],
        }}
        onLeft={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByTestId('netcard-joined')).toBeTruthy();
    expect(screen.getByText('Prediction Markets')).toBeTruthy();
    expect(screen.getByTestId('netcard-joined-state').textContent).toMatch(/joined/i);
    expect(screen.getByTestId('netcard-joined-roles').textContent).toBe('solver');
    expect(screen.getByTestId('netcard-joined-harness').textContent).toBe(
      'Claude Code',
    );
    expect(screen.getByTestId('netcard-joined-manifest-cid').textContent).toBe(
      'bafybeiaaa',
    );
  });

  it('formats tiny joined manifest prices as gwei', () => {
    render(
      <NetCard
        manifestCid="bafybeiaaa"
        manifest={{
          ...baseManifest,
          solutionPriceWei: '10000000000',
          verdictPriceWei: '5000000000',
        }}
        joined={{ roles: ['solver'] }}
        onLeft={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    expect(screen.getByText('10 gwei')).toBeTruthy();
    expect(screen.getByText('5 gwei')).toBeTruthy();
    expect(screen.queryByText(/e-/i)).toBeNull();
  });

  it('shows the manifest evaluator binding when evaluator role is joined', () => {
    render(
      <NetCard
        manifestCid="bafybeiaaa"
        manifest={baseManifest}
        joined={{ roles: ['evaluator'] }}
        onLeft={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('netcard-joined-evaluator-binding').textContent,
    ).toMatch(/jinn-builtin\/prediction-v1-eval@1\.0/);
    // Solver-only fields hidden when only evaluator is joined.
    expect(screen.queryByTestId('netcard-joined-harness')).toBeNull();
  });

  it('Leave button calls api.operator.leave and notifies onLeft on success', async () => {
    const onLeft = vi.fn();
    const onRestartPending = vi.fn();
    render(
      <NetCard
        manifestCid="bafybeiaaa"
        manifest={baseManifest}
        joined={{ roles: ['solver'], harness: 'claude-code-learner' }}
        onLeft={onLeft}
        onRestartPending={onRestartPending}
      />,
    );

    fireEvent.click(screen.getByTestId('netcard-joined-leave'));
    fireEvent.click(screen.getByTestId('netcard-joined-leave-confirm'));

    await waitFor(() => expect(apiMock.operatorLeave).toHaveBeenCalledWith('bafybeiaaa'));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(onRestartPending).toHaveBeenCalled();
  });

  it('surfaces an error from leave without calling onLeft', async () => {
    apiMock.operatorLeave.mockRejectedValue(new Error('config_write_failed'));
    const onLeft = vi.fn();
    render(
      <NetCard
        manifestCid="bafybeiaaa"
        manifest={baseManifest}
        joined={{ roles: ['solver'] }}
        onLeft={onLeft}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('netcard-joined-leave'));
    fireEvent.click(screen.getByTestId('netcard-joined-leave-confirm'));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/config_write_failed/),
    );
    expect(onLeft).not.toHaveBeenCalled();
  });
});

// ── NetCard legacy props still work (regression) ─────────────────────────────

describe('NetCard — legacy mode regression', () => {
  it('still renders the legacy catalog row when {catalog, config} props are passed', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          roles: ['solving'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    // Legacy state pill says "Live" / "Available", not "Joined".
    expect(screen.queryByTestId('netcard-joined')).toBeNull();
    expect(screen.getByText(/live/i)).toBeTruthy();
  });
});
