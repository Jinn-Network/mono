import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Step5ReviewLaunch } from './Step5ReviewLaunch.js';
import {
  PREDICTION_V1_TEMPLATE,
  SWE_REBENCH_V2_V1_TEMPLATE,
} from './templates.js';
import type {
  DraftSolverNetRecord,
  LaunchedSolverNetRecord,
} from '../../../../../api/contract/index.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: {
    solvernets: {
      launch: vi.fn(),
      get: vi.fn(),
    },
  },
}));

function buildDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'd1',
    name: 'Polymarket',
    description: 'Forecast resolved markets',
    templateContractId: 'prediction',
    templateContractVersion: 'v1',
    generatorConfig: {
      cadenceMs: 21600000,
      windowMs: 21600000,
      maxOpenRounds: 250,
      allowlistConditionIds: ['0xabc'],
      blocklistConditionIds: [],
    },
    solutionPriceWei: '100',
    verdictPriceWei: '50',
    completedSteps: ['define', 'reviewContract', 'configureGenerator', 'configurePricing'],
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    ...overrides,
  };
}

function buildLaunched(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    manifestCid: 'bafy...',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launching',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    registry: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Step5ReviewLaunch', () => {
  it('renders the manifest summary with name + pricing + cadence', () => {
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
      />,
    );
    const summary = screen.getByTestId('launcher-create-manifest-summary');
    expect(summary.textContent).toContain('Polymarket');
    expect(summary.textContent).toContain('Forecast resolved markets');
    expect(summary.textContent).toContain('100 wei');
    expect(summary.textContent).toContain('50 wei');
    expect(summary.textContent).toContain('21600000');
    expect(summary.textContent).toContain('1 entries');
  });

  it('defaults openRoles to [solver, evaluator] when draft has none', () => {
    render(
      <Step5ReviewLaunch
        draft={buildDraft({ openRoles: undefined })}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(
      (screen.getByTestId('launcher-create-openRoles-solver') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('launcher-create-openRoles-evaluator') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('disables Launch and shows error when both checkboxes are unchecked', () => {
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-openRoles-solver'));
    fireEvent.click(screen.getByTestId('launcher-create-openRoles-evaluator'));
    const next = screen.getByTestId('launcher-create-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByTestId('launcher-create-openRoles-error').textContent).toMatch(
      /At least one role/,
    );
  });

  it('happy-path Launch: progresses phases and navigates on launched status', async () => {
    const navigate = vi.fn();
    const onUpdateDraft = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.solvernets.launch).mockResolvedValue({
      solverNetId: 'sn-1',
      status: 'launching',
      pollUrl: '/v1/solvernets/launched/sn-1',
    });
    // Simulate progress: pinning → confirming → launched
    vi.mocked(api.solvernets.get)
      .mockResolvedValueOnce(
        buildLaunched({
          solverNetId: 'sn-1',
          status: 'launching',
          launchProgress: { phase: 'pinning', attemptCount: 0 },
        }),
      )
      .mockResolvedValueOnce(
        buildLaunched({
          solverNetId: 'sn-1',
          status: 'launching',
          launchProgress: { phase: 'confirming', attemptCount: 1 },
        }),
      )
      .mockResolvedValueOnce(
        buildLaunched({
          solverNetId: 'sn-1',
          status: 'launched',
          launchProgress: { phase: 'spawning', attemptCount: 1 },
        }),
      );

    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={onUpdateDraft}
        onBack={() => undefined}
        navigateTo={navigate}
        pollIntervalMs={5}
      />,
    );

    fireEvent.click(screen.getByTestId('launcher-create-next'));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/launcher/launched/sn-1'),
    );
    expect(onUpdateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        openRoles: ['solver', 'evaluator'],
      }),
    );
    expect(api.solvernets.launch).toHaveBeenCalledWith('d1');
  });

  it('failed-status Launch surfaces error with retry + abandon', async () => {
    const navigate = vi.fn();
    vi.mocked(api.solvernets.launch).mockResolvedValue({
      solverNetId: 'sn-1',
      status: 'launching',
      pollUrl: '/v1/solvernets/launched/sn-1',
    });
    vi.mocked(api.solvernets.get).mockResolvedValueOnce(
      buildLaunched({
        solverNetId: 'sn-1',
        status: 'failed',
        launchProgress: {
          phase: 'broadcasting',
          attemptCount: 3,
          txError: { message: 'reverted: out of gas', at: '2026-05-05T15:01:00Z' },
        },
      }),
    );
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
        navigateTo={navigate}
        pollIntervalMs={5}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    const failure = await screen.findByTestId('launcher-create-launch-failure');
    expect(failure.textContent).toContain('reverted: out of gas');
    expect(screen.getByTestId('launcher-create-launch-retry')).toBeTruthy();
    expect(screen.getByTestId('launcher-create-launch-abandon')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Abandon after failure navigates back to /launcher', async () => {
    const navigate = vi.fn();
    vi.mocked(api.solvernets.launch).mockResolvedValue({
      solverNetId: 'sn-1',
      status: 'launching',
      pollUrl: '/v1/solvernets/launched/sn-1',
    });
    vi.mocked(api.solvernets.get).mockResolvedValueOnce(
      buildLaunched({
        solverNetId: 'sn-1',
        status: 'failed',
        launchProgress: { phase: 'broadcasting', attemptCount: 1 },
      }),
    );
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
        navigateTo={navigate}
        pollIntervalMs={5}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    await screen.findByTestId('launcher-create-launch-failure');
    fireEvent.click(screen.getByTestId('launcher-create-launch-abandon'));
    expect(navigate).toHaveBeenCalledWith('/launcher');
  });

  it('Launch failure from a thrown launch() promise surfaces inline', async () => {
    vi.mocked(api.solvernets.launch).mockRejectedValue(
      new Error('500 Internal Server Error on /v1/solvernets/drafts/d1/launch'),
    );
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
        navigateTo={() => undefined}
        pollIntervalMs={5}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    const failure = await screen.findByTestId('launcher-create-launch-failure');
    expect(failure.textContent).toContain('500 Internal Server Error');
  });

  it('Back invokes onBack', () => {
    const onBack = vi.fn();
    render(
      <Step5ReviewLaunch
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('renders the swe-rebench-v2 manifest summary with target/window fields', () => {
    render(
      <Step5ReviewLaunch
        draft={buildDraft({
          templateContractId: 'swe-rebench-v2',
          templateContractVersion: 'v1',
          generatorConfig: {
            N_target_successes: 5,
            posting_window_ms: 86_400_000,
            post_batch_size: 25,
          },
        })}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onUpdateDraft={() => undefined}
        onBack={() => undefined}
      />,
    );
    const summary = screen.getByTestId('launcher-create-manifest-summary');
    expect(summary.textContent).toContain('swe-rebench-v2.v1');
    expect(summary.textContent).toContain('Target successes');
    expect(summary.textContent).toContain('5');
    expect(summary.textContent).toContain('86400000 ms');
    expect(summary.textContent).toContain('Batch size');
    expect(summary.textContent).toContain('25');
    // #802: the abandon-cap summary line is removed.
    expect(summary.textContent).not.toContain('Max postings');
    // No prediction-only labels
    expect(summary.textContent).not.toContain('Cadence');
    expect(summary.textContent).not.toContain('Allowlist');
  });
});
