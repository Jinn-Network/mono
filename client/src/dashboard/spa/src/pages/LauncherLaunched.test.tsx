import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { LauncherLaunchedPage } from './LauncherLaunched.js';
import { api } from '../api/client.js';
import type {
  LaunchedSolverNetRecord,
  LauncherStatusResponse,
  LauncherTasksResponse,
  RegistryManifestResponse,
  SolverNetManifestV1,
} from '../../../../api/contract/index.js';

import type { JSX } from 'react';

vi.mock('../api/client.js', () => ({
  api: {
    fetchLauncherStatus: vi.fn(),
    fetchLauncherTasks: vi.fn(),
    solvernets: {
      get: vi.fn(),
      getManifest: vi.fn(),
      transitionLifecycle: vi.fn(),
      updateGeneratorConfig: vi.fn(),
    },
    discovery: {
      getSolverNetOperatorCount: vi.fn(),
    },
  },
}));

function buildRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn-1',
    manifestCid: 'bafybeigtest1234567890',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    generatorConfig: {
      cadenceMs: 21600000,
      submissionWindowMs: 21600000,
      resolveGapMs: 3600000,
      maxNewRoundsPerPoll: 25,
      maxNewRoundsPerDay: 100,
      maxOpenRounds: 250,
      allowlistConditionIds: [],
      blocklistConditionIds: [],
    },
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
    description: 'Forecast resolved markets',
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

function buildManifestResponse(): RegistryManifestResponse {
  return {
    manifest: buildManifest(),
    lifecycle: {
      status: 'launched',
      statusUpdatedAt: '2026-05-05T15:00:00Z',
      sourceBlock: 1,
    },
  };
}

function wrap(
  ui: JSX.Element,
  initialPath = '/launcher/launched/sn-1',
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
      <Router hook={nav.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
  return { rendered, nav };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty tasks list, empty launcher status — keeps the panels
  // out of the way for tests that focus on lifecycle / hot-apply.
  vi.mocked(api.fetchLauncherTasks).mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '',
    tasks: [],
  } satisfies LauncherTasksResponse);
  vi.mocked(api.fetchLauncherStatus).mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '',
    nets: [],
  } satisfies LauncherStatusResponse);
  // Default: 0 participating operators. Per-test overrides set a real count.
  vi.mocked(api.discovery.getSolverNetOperatorCount).mockResolvedValue({
    manifestCid: 'bafybeigtest1234567890',
    operatorCount: 0,
  });
});

afterEach(() => {
  cleanup();
});

describe('LauncherLaunchedPage', () => {
  it('renders loading state while record query is pending', () => {
    vi.mocked(api.solvernets.get).mockReturnValue(new Promise(() => undefined));
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);
    expect(screen.getByTestId('launcher-launched-loading')).toBeTruthy();
  });

  it('renders error state with retry + back when record fetch fails', async () => {
    vi.mocked(api.solvernets.get).mockRejectedValue(new Error('404 Not Found'));
    wrap(<LauncherLaunchedPage solverNetId="sn-unknown" pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-error')).toBeTruthy(),
    );
    expect(screen.getByText(/404 Not Found/)).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-error-retry')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-error-back')).toBeTruthy();
  });

  it('renders all four panels when record + manifest load successfully', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-status-header')).toBeTruthy(),
    );
    expect(screen.getByTestId('launcher-launched-generator-panel')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-tasks-panel')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-spend-panel')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-name').textContent).toBe('Polymarket'),
    );
  });

  it('passes the launched manifest CID when polling recent posted tasks', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(api.fetchLauncherTasks).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 5,
        manifestCid: 'bafybeigtest1234567890',
      }),
    );
  });

  it('renders manifest fields (not placeholders) for an owned launching record (issue #114)', async () => {
    // Simulates the just-launched window: record.status === 'launching',
    // registry.metadataBlockNumber undefined. The API now serves the
    // hash-verified owned manifest with a synthesised launched lifecycle
    // (sourceBlock: 0), so name + prices render instead of placeholders.
    vi.mocked(api.solvernets.get).mockResolvedValue(
      buildRecord({ status: 'launching', registry: {} }),
    );
    vi.mocked(api.solvernets.getManifest).mockResolvedValue({
      manifest: buildManifest({ name: 'Polymarket' }),
      lifecycle: {
        status: 'launched',
        statusUpdatedAt: '2026-05-05T15:00:00Z',
        sourceBlock: 0,
      },
    });
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-name').textContent).toBe('Polymarket'),
    );
    // Spend panel renders manifest-sourced prices (not the '—' placeholder
    // SpendPanel falls back to when the manifest is missing). The issue
    // explicitly names "missing prices" as a symptom, so assert on the price
    // testids that surface that symptom.
    expect(screen.getByTestId('launcher-launched-spend-panel')).toBeTruthy();
    expect(
      screen.getByTestId('launcher-launched-spend-solution-price').textContent,
    ).not.toBe('—');
    expect(
      screen.getByTestId('launcher-launched-spend-verdict-price').textContent,
    ).not.toBe('—');
  });

  it('surfaces the operator-join count from the discovery API (issue #351)', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.discovery.getSolverNetOperatorCount).mockResolvedValue({
      manifestCid: 'bafybeigtest1234567890',
      operatorCount: 2,
    });
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId('operator-count').textContent).toBe('2'),
    );
    expect(api.discovery.getSolverNetOperatorCount).toHaveBeenCalledWith(
      'bafybeigtest1234567890',
    );
  });

  it('omits the operator-count field when the discovery query fails', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.discovery.getSolverNetOperatorCount).mockRejectedValue(
      new Error('discovery_unavailable'),
    );
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-status-header')).toBeTruthy(),
    );
    expect(screen.queryByTestId('operator-count')).toBeNull();
  });

  it('still renders panels when manifest fetch fails (degrades gracefully)', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockRejectedValue(new Error('IPFS down'));
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-manifest-error')).toBeTruthy(),
    );
    // Status header still renders (with fallback name).
    expect(screen.getByTestId('launcher-launched-status-header')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-name').textContent).toBe('sn-1');
  });

  it('Pause button → dialog → confirm calls transitionLifecycle("paused") and refetches', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.solvernets.transitionLifecycle).mockResolvedValue(
      buildRecord({ status: 'paused' }),
    );

    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-action-paused')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('launcher-launched-action-paused'));
    expect(screen.getByTestId('launcher-launched-dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('launcher-launched-dialog-confirm'));
    await waitFor(() =>
      expect(api.solvernets.transitionLifecycle).toHaveBeenCalledWith('sn-1', 'paused'),
    );
    // Dialog closes after success.
    await waitFor(() =>
      expect(screen.queryByTestId('launcher-launched-dialog')).toBeNull(),
    );
    // Status badge reflects the new state via the cache update.
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-status-badge').textContent,
      ).toBe('Paused'),
    );
  });

  it('Retire button → dialog → typed-confirm calls transitionLifecycle("retired")', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.solvernets.transitionLifecycle).mockResolvedValue(
      buildRecord({ status: 'retired' }),
    );

    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-action-retired')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('launcher-launched-action-retired'));

    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('launcher-launched-dialog-typed'), {
      target: { value: 'Polymarket' },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(api.solvernets.transitionLifecycle).toHaveBeenCalledWith('sn-1', 'retired'),
    );
  });

  it('lifecycle error stays in the dialog with the message', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.solvernets.transitionLifecycle).mockRejectedValue(
      new Error('500 transient error'),
    );

    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-action-paused')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('launcher-launched-action-paused'));
    fireEvent.click(screen.getByTestId('launcher-launched-dialog-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-dialog-error').textContent).toBe(
        '500 transient error',
      ),
    );
    // Dialog stays open so operator can retry.
    expect(screen.getByTestId('launcher-launched-dialog')).toBeTruthy();
  });

  it('hot-apply: GeneratorPanel save calls updateGeneratorConfig and refetches the record', async () => {
    let getCallCount = 0;
    vi.mocked(api.solvernets.get).mockImplementation(async () => {
      getCallCount += 1;
      if (getCallCount > 1) {
        return buildRecord({
          generatorConfig: {
            ...buildRecord().generatorConfig,
            maxOpenRounds: 500,
          },
        });
      }
      return buildRecord();
    });
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    vi.mocked(api.solvernets.updateGeneratorConfig).mockResolvedValue({
      maxOpenRounds: 500,
    });

    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-generator-toggle')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('launcher-launched-generator-toggle'));
    await waitFor(() =>
      expect(
        (screen.getByTestId('launcher-launched-generator-maxOpenRounds') as HTMLInputElement).value,
      ).toBe('250'),
    );

    fireEvent.change(screen.getByTestId('launcher-launched-generator-maxOpenRounds'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));

    await waitFor(() =>
      expect(api.solvernets.updateGeneratorConfig).toHaveBeenCalledWith('sn-1', {
        maxOpenRounds: 500,
      }),
    );
    // Refetch happens via invalidateQueries — the mocked second `get` returns
    // the new value, so the input re-syncs to 500 once the record updates.
    await waitFor(() =>
      expect(
        (screen.getByTestId('launcher-launched-generator-maxOpenRounds') as HTMLInputElement).value,
      ).toBe('500'),
    );
  });

  it('hot-apply: renders the swe-rebench-v2 config form from the launched manifest template', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(
      buildRecord({ generatorConfig: {}, summary: undefined }),
    );
    const predictionManifest = buildManifest();
    vi.mocked(api.solvernets.getManifest).mockResolvedValue({
      ...buildManifestResponse(),
      manifest: buildManifest({
        name: 'SWE-rebench v2',
        contract: {
          ...predictionManifest.contract,
          id: 'swe-rebench-v2',
          version: 'v1',
          claimPolicyDefaults: {
            mode: 'parallel',
            maxClaims: 5,
            maxClaimsPerOperator: 5,
            claimLeaseTtlSeconds: 3600,
          },
        },
      }),
    });

    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-generator-toggle')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-name').textContent).toBe(
        'SWE-rebench v2',
      ),
    );
    fireEvent.click(screen.getByTestId('launcher-launched-generator-toggle'));

    expect(screen.getByTestId('launcher-launched-generator-N_target_successes')).toBeTruthy();
    // #802: the abandon-cap field is removed from the launched-record editor.
    expect(
      screen.queryByTestId('launcher-launched-generator-N_max_postings_per_task'),
    ).toBeNull();
    expect(screen.getByTestId('launcher-launched-generator-posting_window_ms')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-generator-post_batch_size')).toBeTruthy();
    expect(screen.queryByTestId('launcher-launched-generator-cadenceMs')).toBeNull();
  });

  it('terminal record (retired) shows no actions', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord({ status: 'retired' }));
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-terminal-pill')).toBeTruthy(),
    );
    expect(screen.queryByTestId('launcher-launched-action-paused')).toBeNull();
    expect(screen.queryByTestId('launcher-launched-action-retired')).toBeNull();
  });

  it('renders the missing-id banner when no solverNetId is supplied', () => {
    wrap(<LauncherLaunchedPage solverNetId="" pollIntervalMs={10_000} />, '/launcher/launched');
    expect(screen.getByTestId('launcher-launched-missing-id')).toBeTruthy();
  });

  it('Cancel on the dialog closes it without calling the API', async () => {
    vi.mocked(api.solvernets.get).mockResolvedValue(buildRecord());
    vi.mocked(api.solvernets.getManifest).mockResolvedValue(buildManifestResponse());
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-action-paused')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('launcher-launched-action-paused'));
    fireEvent.click(screen.getByTestId('launcher-launched-dialog-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('launcher-launched-dialog')).toBeNull(),
    );
    expect(api.solvernets.transitionLifecycle).not.toHaveBeenCalled();
  });
});
