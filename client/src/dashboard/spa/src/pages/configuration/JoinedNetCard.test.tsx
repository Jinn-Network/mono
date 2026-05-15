import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { JoinedNetCard, type JoinedNetEntry } from './JoinedNetCard.js';
import type { SolverNetCatalogEntry } from '../../api/types.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      join: vi.fn(),
      leave: vi.fn(),
    },
    solvernets: {
      // Tests that pass `catalogEntry` explicitly skip these. Tests that
      // exercise the internal resolve path mock these per-test.
      getManifest: vi.fn().mockRejectedValue(new Error('manifest_not_found')),
    },
    getSolverNets: vi.fn().mockRejectedValue(new Error('no catalog')),
  },
}));

function wrap(ui: JSX.Element): void {
  const { hook } = memoryLocation({ path: '/operator' });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{ui}</Router>
    </QueryClientProvider>,
  );
}

const ENTRY: JoinedNetEntry = {
  manifestCid: 'bafybeiaaa',
  name: 'Prediction Markets',
  contract: { id: 'prediction', version: 'v1' },
  roles: ['solver', 'evaluator'],
  harness: 'claude-code-learner',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
};

const CATALOG: SolverNetCatalogEntry = {
  name: 'Prediction Markets',
  description: 'Predict things',
  state: 'live',
  contract: { id: 'prediction', version: 'v1' },
  supportedRoles: ['solving', 'evaluating'],
  compatibleHarnesses: [
    { name: 'prediction-v1-baseline', version: '0.1.0', supportsRoles: ['solving'] },
    { name: 'legacy-claude', version: '0.2.0', supportsRoles: ['solving'] },
  ],
  compatiblePlugins: [
    { name: 'plug-a', version: '0.1.0', source: 'jinn' },
    { name: 'plug-b', version: '0.1.0', source: 'jinn' },
  ],
};

const SWE_CATALOG: SolverNetCatalogEntry = {
  name: 'swe-rebench-v2',
  description: 'SWE-rebench v2',
  state: 'live',
  contract: { id: 'swe-rebench-v2', version: 'v1' },
  supportedRoles: ['solving', 'evaluating'],
  compatibleHarnesses: [
    { name: 'codex-code-learner', version: '0.1.0', supportsRoles: ['solving'] },
    { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] },
    { name: 'swe-rebench-v2-evaluator', version: '0.1.0', supportsRoles: ['evaluating'] },
  ],
  compatiblePlugins: [
    { name: 'swe-rebench-v2-runtime', version: '0.1.0', source: 'bundled' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the suite-level fail-fast defaults so per-test overrides don't
  // leak across cases.
  vi.mocked(api.solvernets.getManifest).mockRejectedValue(
    new Error('manifest_not_found'),
  );
  vi.mocked(api.getSolverNets).mockRejectedValue(new Error('no catalog'));
});

afterEach(() => {
  cleanup();
});

describe('<JoinedNetCard />', () => {
  it('renders the collapsed view by default with the joined config summary', () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} />);
    expect(screen.getByTestId('joined-net-card').getAttribute('data-expanded')).toBe('false');
    expect(screen.getByText('Prediction Markets')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.queryByText('claude-code-learner')).toBeNull();
    // Collapsed view shows the friendly tier label, not the pinned id.
    expect(screen.getByText('Haiku')).toBeTruthy();
    expect(screen.queryByText('claude-haiku-4-5-20251001')).toBeNull();
    expect(screen.queryByTestId('joined-net-card-form')).toBeNull();
  });

  it('expands when defaultExpanded is true', () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    expect(screen.getByTestId('joined-net-card').getAttribute('data-expanded')).toBe('true');
    expect(screen.getByTestId('joined-net-card-form')).toBeTruthy();
  });

  it('toggles between collapsed and expanded on click', () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} />);
    const toggle = screen.getByTestId('joined-net-card-toggle');
    fireEvent.click(toggle);
    expect(screen.getByTestId('joined-net-card-form')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('joined-net-card-form')).toBeNull();
  });

  it('shows the incompatible warning when the harness is not in compatibleHarnesses', () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    // claude-code-learner is not in the catalog's compatibleHarnesses for this entry.
    expect(screen.getByTestId('joined-net-card-warn-expanded')).toBeTruthy();
  });

  it('shows "catalog has no template" when manifest resolves but catalog has no matching contract', async () => {
    // Manifest succeeds with an unrecognised contract; catalog returns an
    // entry for a different contract. The card should fall through to the
    // "no template for this contract" state — distinct from orphaned (which
    // requires the manifest fetch itself to fail).
    vi.mocked(api.solvernets.getManifest).mockResolvedValue({
      manifest: {
        contract: { id: 'unknown-protocol', version: 'v1' },
      },
    } as never);
    vi.mocked(api.getSolverNets).mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-05-07T00:00:00Z',
      nets: [
        {
          name: 'prediction',
          description: '',
          state: 'live',
          contract: { id: 'prediction', version: 'v1' },
          supportedRoles: ['solving'],
          compatibleHarnesses: [],
          compatiblePlugins: [],
        },
      ],
    });
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={undefined} defaultExpanded />);
    // catalogEntry={undefined} explicitly — but the prop being present
    // (not omitted) means skipResolve=false, so the resolve runs.
    await waitFor(() =>
      expect(screen.getByTestId('joined-net-card-catalog-missing')).toBeTruthy(),
    );
    expect(screen.queryByTestId('joined-net-card-warn-expanded')).toBeNull();
    // Not orphaned because manifest fetch succeeded.
    expect(screen.queryByTestId('joined-net-card-orphaned')).toBeNull();
  });

  it('does NOT show incompatible warning when the harness is in compatibleHarnesses', () => {
    const compatible = { ...ENTRY, harness: 'legacy-claude' };
    wrap(<JoinedNetCard joined={compatible} catalogEntry={CATALOG} defaultExpanded />);
    expect(screen.queryByTestId('joined-net-card-warn-expanded')).toBeNull();
  });

  it('offers both Codex and Claude learner harnesses for SWE and uses Codex model options', () => {
    wrap(
      <JoinedNetCard
        joined={{
          manifestCid: 'bafyreibbb',
          name: 'SWE-rebench v2',
          roles: ['solver', 'evaluator'],
          harness: 'codex-code-learner',
          model: 'gpt-5.4-mini',
          plugins: ['bundled:swe-rebench-v2-runtime'],
        }}
        catalogEntry={SWE_CATALOG}
        defaultExpanded
      />,
    );

    const harnessSelect = screen.getByTestId('joined-net-card-harness-select') as HTMLSelectElement;
    const harnessOptions = Array.from(harnessSelect.options).map((o) => o.value);
    expect(harnessOptions).toContain('codex');
    expect(harnessOptions).toContain('claude-code');
    expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toContain('Codex 0.1.0');
    expect(Array.from(harnessSelect.options).map((o) => o.textContent)).toContain('Claude Code 0.1.0');

    const modelSelect = screen.getByTestId('joined-net-card-model-select') as HTMLSelectElement;
    const codexModelOptions = Array.from(modelSelect.options).map((o) => o.value);
    expect(codexModelOptions).toContain('gpt-5.4-mini');
    expect(codexModelOptions).toContain('gpt-5.5');
    expect(codexModelOptions).not.toContain('claude-haiku-4-5-20251001');

    const sweRuntimeChips = screen
      .getAllByTestId('joined-net-card-plugin-row-chip')
      .filter((chip) => chip.getAttribute('data-plugin') === 'swe-rebench-v2-runtime');
    expect(sweRuntimeChips).toHaveLength(1);

    fireEvent.click(screen.getByTestId('joined-net-card-plugin-row-trigger'));
    expect(
      screen
        .queryAllByTestId('joined-net-card-plugin-row')
        .some((row) => row.getAttribute('data-plugin') === 'swe-rebench-v2-runtime' || row.getAttribute('data-plugin') === 'bundled:swe-rebench-v2-runtime'),
    ).toBe(false);

    fireEvent.change(harnessSelect, { target: { value: 'claude-code' } });
    const claudeModelOptions = Array.from(modelSelect.options).map((o) => o.value);
    expect(claudeModelOptions).toContain('claude-haiku-4-5-20251001');
    expect(claudeModelOptions).not.toContain('gpt-5.5');
  });

  it('disables Save until the form is dirty', async () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    const save = screen.getByTestId('joined-net-card-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Toggle a plugin → form becomes dirty → Save enables.
    fireEvent.click(screen.getByTestId('joined-net-card-plugin-row-trigger'));
    const plugA = screen
      .getAllByTestId('joined-net-card-plugin-row')
      .find((el) => el.getAttribute('data-plugin') === 'plug-a');
    expect(plugA).toBeTruthy();
    fireEvent.click(plugA!);
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('Cancel reverts dirty form back to the original snapshot', async () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    fireEvent.click(screen.getByTestId('joined-net-card-plugin-row-trigger'));
    const plugA = screen
      .getAllByTestId('joined-net-card-plugin-row')
      .find((el) => el.getAttribute('data-plugin') === 'plug-a')!;
    fireEvent.click(plugA);
    await waitFor(() => expect(
      (screen.getByTestId('joined-net-card-save') as HTMLButtonElement).disabled,
    ).toBe(false));

    fireEvent.click(screen.getByTestId('joined-net-card-cancel'));
    fireEvent.click(screen.getByTestId('joined-net-card-plugin-row-trigger'));
    const revertedPlugA = screen
      .getAllByTestId('joined-net-card-plugin-row')
      .find((el) => el.getAttribute('data-plugin') === 'plug-a')!;
    expect(revertedPlugA.getAttribute('data-plugin-active')).toBe('false');
    expect(
      (screen.getByTestId('joined-net-card-save') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('warns before disabling a default plugin and persists the opt-out', async () => {
    vi.mocked(api.operator.join).mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
      config: {
        manifestCid: 'bafybeiaaa',
        name: 'Prediction Markets',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: ['network-tools'],
        model: 'claude-haiku-4-5-20251001',
      },
    });

    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    const removeNetwork = screen
      .getAllByTestId('joined-net-card-plugin-row-remove')
      .find((button) => button.getAttribute('data-plugin') === 'network-tools')!;
    fireEvent.click(removeNetwork);
    expect(screen.getByTestId('joined-net-card-plugin-row-default-warning')).toBeTruthy();
    fireEvent.click(screen.getByTestId('joined-net-card-plugin-row-default-warning-confirm'));
    fireEvent.click(screen.getByTestId('joined-net-card-save'));

    await waitFor(() =>
      expect(api.operator.join).toHaveBeenCalledWith('bafybeiaaa', {
        name: 'Prediction Markets',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: ['network-tools'],
        model: 'claude-haiku-4-5-20251001',
      }),
    );
  });

  it('Save calls api.operator.join with the full body and triggers onRestartPending', async () => {
    vi.mocked(api.operator.join).mockResolvedValue({
      ok: true,
      restartRequired: true,
      manifestCid: 'bafybeiaaa',
      config: {
        manifestCid: 'bafybeiaaa',
        name: 'Prediction Markets',
        roles: ['solver', 'evaluator'],
        harness: 'legacy-claude',
        plugins: [],
        disabledDefaultPlugins: [],
        model: 'claude-haiku-4-5-20251001',
      },
    });
    const onRestart = vi.fn();
    wrap(
      <JoinedNetCard
        joined={ENTRY}
        catalogEntry={CATALOG}
        defaultExpanded
        onRestartPending={onRestart}
      />,
    );
    // Switch harness to a compatible one.
    fireEvent.change(screen.getByTestId('joined-net-card-harness-select'), {
      target: { value: 'legacy-claude' },
    });
    fireEvent.click(screen.getByTestId('joined-net-card-save'));
    await waitFor(() =>
      expect(api.operator.join).toHaveBeenCalledWith('bafybeiaaa', {
        name: 'Prediction Markets',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'legacy-claude',
        plugins: [],
        disabledDefaultPlugins: [],
        model: 'claude-haiku-4-5-20251001',
      }),
    );
    await waitFor(() => expect(onRestart).toHaveBeenCalled());
  });

  it('active cards expose Leave in the expanded form (Danger zone), even when manifest is healthy', () => {
    wrap(<JoinedNetCard joined={ENTRY} catalogEntry={CATALOG} defaultExpanded />);
    // Active card: form mounts; leave-zone is at the bottom of the form.
    expect(screen.getByTestId('joined-net-card-form')).toBeTruthy();
    expect(screen.getByTestId('joined-net-card-leave-zone')).toBeTruthy();
    expect(screen.getByTestId('joined-net-card-leave')).toBeTruthy();
    // Orphaned banner does NOT render.
    expect(screen.queryByTestId('joined-net-card-orphaned')).toBeNull();
  });

  describe('orphaned state (manifest fetch fails)', () => {
    it('shows the RETIRED banner and a Leave button, no edit form, when manifest fetch fails', async () => {
      // Card resolves internally; the suite-level mock makes both queries fail.
      wrap(<JoinedNetCard joined={ENTRY} defaultExpanded />);
      await waitFor(() =>
        expect(screen.getByTestId('joined-net-card-orphaned')).toBeTruthy(),
      );
      // Leave button replaces the Edit toggle.
      expect(screen.getByTestId('joined-net-card-leave')).toBeTruthy();
      expect(screen.queryByTestId('joined-net-card-toggle')).toBeNull();
      // Form is suppressed even though defaultExpanded was set.
      expect(screen.queryByTestId('joined-net-card-form')).toBeNull();
    });

    it('Leave → Confirm calls api.operator.leave and triggers onRestartPending', async () => {
      vi.mocked(api.operator.leave).mockResolvedValue({
        ok: true,
        restartRequired: true,
        manifestCid: 'bafybeiaaa',
      });
      const onRestart = vi.fn();
      wrap(<JoinedNetCard joined={ENTRY} onRestartPending={onRestart} />);
      const leaveBtn = await waitFor(() =>
        screen.getByTestId('joined-net-card-leave'),
      );
      fireEvent.click(leaveBtn);
      // First click swaps to confirm UI.
      const confirmBtn = screen.getByTestId('joined-net-card-leave-confirm');
      const cancelBtn = screen.getByTestId('joined-net-card-leave-cancel');
      expect(cancelBtn).toBeTruthy();
      fireEvent.click(confirmBtn);
      await waitFor(() =>
        expect(api.operator.leave).toHaveBeenCalledWith('bafybeiaaa'),
      );
      await waitFor(() => expect(onRestart).toHaveBeenCalled());
    });

    it('Leave → Cancel returns to the Leave button', async () => {
      wrap(<JoinedNetCard joined={ENTRY} />);
      const leaveBtn = await waitFor(() =>
        screen.getByTestId('joined-net-card-leave'),
      );
      fireEvent.click(leaveBtn);
      fireEvent.click(screen.getByTestId('joined-net-card-leave-cancel'));
      expect(screen.getByTestId('joined-net-card-leave')).toBeTruthy();
      expect(screen.queryByTestId('joined-net-card-leave-confirm')).toBeNull();
    });
  });

  it('does not call onRestartPending when restartRequired is false', async () => {
    vi.mocked(api.operator.join).mockResolvedValue({
      ok: true,
      restartRequired: false,
      manifestCid: 'bafybeiaaa',
      config: {
        manifestCid: 'bafybeiaaa',
        roles: ['solver', 'evaluator'],
      },
    });
    const onRestart = vi.fn();
    wrap(
      <JoinedNetCard
        joined={ENTRY}
        catalogEntry={CATALOG}
        defaultExpanded
        onRestartPending={onRestart}
      />,
    );
    fireEvent.change(screen.getByTestId('joined-net-card-harness-select'), {
      target: { value: 'legacy-claude' },
    });
    fireEvent.click(screen.getByTestId('joined-net-card-save'));
    await waitFor(() => expect(api.operator.join).toHaveBeenCalled());
    expect(onRestart).not.toHaveBeenCalled();
  });
});
