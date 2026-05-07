import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Step3ConfigureGenerator,
  validateGeneratorConfig,
} from './Step3ConfigureGenerator.js';
import type { DraftSolverNetRecord } from '../../api/types.js';

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

describe('Step3ConfigureGenerator', () => {
  it('pre-fills template defaults when no generatorConfig is set', () => {
    render(
      <Step3ConfigureGenerator
        draft={buildDraft()}
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
        onAdvance={() => undefined}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('validateGeneratorConfig', () => {
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
