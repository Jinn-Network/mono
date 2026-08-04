import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Step3ConfigureGenerator,
  validateGeneratorConfig,
  validateSweRebenchV2GeneratorConfig,
} from './Step3ConfigureGenerator.js';
import {
  PREDICTION_V1_TEMPLATE,
  SWE_REBENCH_V2_V1_TEMPLATE,
} from './templates.js';
import type { DraftSolverNetRecord } from '../../../../../api/contract/index.js';

function buildDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'd1',
    name: 'Polymarket',
    description: 'Forecast markets',
    templateContractId: 'prediction',
    templateContractVersion: 'v1',
    completedSteps: ['define', 'reviewContract'],
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Step3ConfigureGenerator (prediction.v1)', () => {
  it('pre-fills template defaults when no generatorConfig is set', () => {
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    const cadence = screen.getByTestId('launcher-create-cadenceMs') as HTMLInputElement;
    // 6 hours in ms
    expect(cadence.value).toBe(String(6 * 60 * 60 * 1000));
    const maxOpenRounds = screen.getByTestId('launcher-create-maxOpenRounds') as HTMLInputElement;
    expect(maxOpenRounds.value).toBe('250');
  });

  it('pre-fills from existing generatorConfig when present', () => {
    render(
      <Step3ConfigureGenerator
        draft={buildDraft({
          generatorConfig: {
            cadenceMs: 7200000,
            windowMs: 3600000,
            resolveGapMs: 600000,
            maxNewRoundsPerPoll: 10,
            maxNewRoundsPerDay: 50,
            maxOpenRounds: 100,
            allowlistConditionIds: ['0xabc', '0xdef'],
            blocklistConditionIds: [],
          },
        })}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect((screen.getByTestId('launcher-create-cadenceMs') as HTMLInputElement).value).toBe(
      '7200000',
    );
    expect(
      (screen.getByTestId('launcher-create-maxNewRoundsPerPoll') as HTMLInputElement).value,
    ).toBe('10');
    expect(
      (screen.getByTestId('launcher-create-allowlistConditionIds') as HTMLTextAreaElement).value,
    ).toBe('0xabc, 0xdef');
  });

  it('rejects sub-60s cadence', () => {
    const onAdvance = vi.fn();
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-cadenceMs'), {
      target: { value: '5000' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).not.toHaveBeenCalled();
    expect(screen.getByText(/Cadence must be at least 60s/)).toBeTruthy();
  });

  it('rejects non-integer numeric inputs', () => {
    const onAdvance = vi.fn();
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-maxOpenRounds'), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).not.toHaveBeenCalled();
    expect(screen.getByText(/Must be a positive integer\./i)).toBeTruthy();
  });

  it('persists parsed numeric + parsed lists on Next', () => {
    const onAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-allowlistConditionIds'), {
      target: { value: '0xabc, 0xdef , ' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    const patch = onAdvance.mock.calls[0]![0]!;
    expect(patch.completedSteps).toEqual(['define', 'reviewContract', 'configureGenerator']);
    expect(patch.generatorConfig).toMatchObject({
      cadenceMs: 6 * 60 * 60 * 1000,
      maxOpenRounds: 250,
      allowlistConditionIds: ['0xabc', '0xdef'],
      blocklistConditionIds: [],
    });
  });

  it('Back invokes onBack', () => {
    const onBack = vi.fn();
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('Step3ConfigureGenerator (swe-rebench-v2.v1)', () => {
  function buildSweDraft(
    overrides: Partial<DraftSolverNetRecord> = {},
  ): DraftSolverNetRecord {
    return buildDraft({
      templateContractId: 'swe-rebench-v2',
      templateContractVersion: 'v1',
      ...overrides,
    });
  }

  it('renders fill-the-pool inputs and pre-fills swe-rebench defaults', () => {
    render(
      <Step3ConfigureGenerator
        draft={buildSweDraft()}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(
      (screen.getByTestId('launcher-create-N_target_successes') as HTMLInputElement).value,
    ).toBe('5');
    // #802: the abandon-cap field is removed from the wizard.
    expect(screen.queryByTestId('launcher-create-N_max_postings_per_task')).toBeNull();
    expect(
      (screen.getByTestId('launcher-create-posting_window_ms') as HTMLInputElement).value,
    ).toBe(String(24 * 60 * 60 * 1000));
    expect(
      (screen.getByTestId('launcher-create-post_batch_size') as HTMLInputElement).value,
    ).toBe('25');
    expect(
      (screen.getByTestId('launcher-create-maxClaimsPerOperator') as HTMLInputElement).value,
    ).toBe('5');
    expect(
      (screen.getByTestId('launcher-create-claimLeaseTtlSeconds') as HTMLInputElement).value,
    ).toBe('3600');
    // Prediction-only fields must not appear
    expect(screen.queryByTestId('launcher-create-cadenceMs')).toBeNull();
    expect(screen.queryByTestId('launcher-create-allowlistConditionIds')).toBeNull();
  });

  it('pre-fills from existing generatorConfig when present', () => {
    render(
      <Step3ConfigureGenerator
        draft={buildSweDraft({
          generatorConfig: {
            N_target_successes: 5,
            posting_window_ms: 60_000,
            post_batch_size: 7,
            maxClaimsPerOperator: 2,
            claimLeaseTtlSeconds: 1_800,
          },
        })}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(
      (screen.getByTestId('launcher-create-N_target_successes') as HTMLInputElement).value,
    ).toBe('5');
    expect(
      (screen.getByTestId('launcher-create-posting_window_ms') as HTMLInputElement).value,
    ).toBe('60000');
    expect(
      (screen.getByTestId('launcher-create-post_batch_size') as HTMLInputElement).value,
    ).toBe('7');
    expect(
      (screen.getByTestId('launcher-create-maxClaimsPerOperator') as HTMLInputElement).value,
    ).toBe('2');
  });

  it('rejects empty posting window', () => {
    const onAdvance = vi.fn();
    render(
      <Step3ConfigureGenerator
        draft={buildSweDraft()}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-posting_window_ms'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).not.toHaveBeenCalled();
    expect(screen.getByText(/positive integer \(ms\)/)).toBeTruthy();
  });

  it('persists parsed numeric values on Next', () => {
    const onAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <Step3ConfigureGenerator
        draft={buildSweDraft()}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-posting_window_ms'), {
      target: { value: '60000' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    const patch = onAdvance.mock.calls[0]![0]!;
    expect(patch.completedSteps).toEqual(['define', 'reviewContract', 'configureGenerator']);
    expect(patch.generatorConfig).toEqual({
      N_target_successes: 5,
      posting_window_ms: 60_000,
      post_batch_size: 25,
      maxClaimsPerOperator: 5,
      claimLeaseTtlSeconds: 3600,
    });
  });
});

describe('validateGeneratorConfig (prediction.v1)', () => {
  it('accepts the prediction.v1 defaults', () => {
    const r = validateGeneratorConfig({
      cadenceMs: '21600000',
      windowMs: '21600000',
      resolveGapMs: '3600000',
      maxNewRoundsPerPoll: '25',
      maxNewRoundsPerDay: '100',
      maxOpenRounds: '250',
      allowlistConditionIds: '',
      blocklistConditionIds: '',
    });
    expect(r.ok).toBe(true);
    expect(r.generatorConfig?.cadenceMs).toBe(21600000);
    expect(r.generatorConfig?.allowlistConditionIds).toEqual([]);
  });

  it('rejects empty cadence', () => {
    const r = validateGeneratorConfig({
      cadenceMs: '',
      windowMs: '21600000',
      resolveGapMs: '3600000',
      maxNewRoundsPerPoll: '25',
      maxNewRoundsPerDay: '100',
      maxOpenRounds: '250',
      allowlistConditionIds: '',
      blocklistConditionIds: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.cadenceMs).toBeTruthy();
  });
});

describe('validateSweRebenchV2GeneratorConfig', () => {
  it('accepts the swe-rebench-v2 defaults', () => {
    const r = validateSweRebenchV2GeneratorConfig({
      N_target_successes: '5',
      posting_window_ms: String(24 * 60 * 60 * 1000),
      post_batch_size: '25',
      maxClaimsPerOperator: '5',
      claimLeaseTtlSeconds: '3600',
    });
    expect(r.ok).toBe(true);
    // #802: N_max_postings_per_task removed — the abandon cap is gone; the
    // canonical generator config no longer carries it.
    expect(r.generatorConfig).toEqual({
      N_target_successes: 5,
      posting_window_ms: 24 * 60 * 60 * 1000,
      post_batch_size: 25,
      maxClaimsPerOperator: 5,
      claimLeaseTtlSeconds: 3600,
    });
  });

  it('rejects empty posting window', () => {
    const r = validateSweRebenchV2GeneratorConfig({
      N_target_successes: '3',
      posting_window_ms: '',
      post_batch_size: '25',
      maxClaimsPerOperator: '3',
      claimLeaseTtlSeconds: '3600',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.posting_window_ms).toBeTruthy();
  });
});
