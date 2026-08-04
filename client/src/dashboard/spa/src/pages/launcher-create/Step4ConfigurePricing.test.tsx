import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Step4ConfigurePricing,
  validatePricing,
  projectTasks,
} from './Step4ConfigurePricing.js';
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
    completedSteps: ['define', 'reviewContract', 'configureGenerator'],
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

describe('validatePricing', () => {
  it('accepts positive solution + verdict prices', () => {
    const r = validatePricing('1000000000000', '500000000000');
    expect(r.ok).toBe(true);
    expect(r.solutionWei).toBe(1000000000000n);
    expect(r.verdictWei).toBe(500000000000n);
  });

  it('rejects empty inputs', () => {
    const r = validatePricing('', '');
    expect(r.ok).toBe(false);
    expect(r.errors.solutionPriceWei).toBeTruthy();
    expect(r.errors.verdictPriceWei).toBeTruthy();
  });

  it('rejects non-integer inputs', () => {
    const r = validatePricing('1.5', 'abc');
    expect(r.ok).toBe(false);
    expect(r.errors.solutionPriceWei).toBeTruthy();
    expect(r.errors.verdictPriceWei).toBeTruthy();
  });

  it('rejects both-zero', () => {
    const r = validatePricing('0', '0');
    expect(r.ok).toBe(false);
    expect(r.errors.combined).toBeTruthy();
  });

  it('accepts zero verdict if solution is positive', () => {
    const r = validatePricing('100', '0');
    expect(r.ok).toBe(true);
  });
});

describe('projectTasks', () => {
  it('returns null when balance is unknown', () => {
    expect(projectTasks(null, 100n, 100n, 1)).toBeNull();
    expect(projectTasks(undefined, 100n, 100n, 1)).toBeNull();
  });

  it('computes balance / (solution + verdict * maxClaimsPerOperator)', () => {
    // 1 ETH = 1e18 wei. solution=0.1 ETH (1e17 wei), verdict=0.05 ETH (5e16 wei), perTask=1.5e17 wei.
    // 1 ETH safe → 6 tasks.
    const r = projectTasks('1000000000000000000', 100000000000000000n, 50000000000000000n, 1);
    expect(r).not.toBeNull();
    expect(r!.tasks).toBe(6);
    expect(r!.perTaskWei).toBe(150000000000000000n);
  });

  it('uses maxClaimsPerOperator > 1 for verdict scaling', () => {
    const r = projectTasks('1000', 100n, 100n, 5);
    expect(r).not.toBeNull();
    expect(r!.perTaskWei).toBe(600n);
    expect(r!.tasks).toBe(1);
  });
});

describe('Step4ConfigurePricing component', () => {
  it('renders empty inputs by default', () => {
    render(
      <Step4ConfigurePricing
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
        fundingSafeAddress="0xSAFE"
      />,
    );
    expect((screen.getByTestId('launcher-create-solutionPriceWei') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('launcher-create-verdictPriceWei') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('launcher-create-fundingSafe').textContent).toContain('0xSAFE');
  });

  it('renders fallback safe text when none provided', () => {
    render(
      <Step4ConfigurePricing
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
        fundingSafeAddress={null}
      />,
    );
    expect(screen.getByTestId('launcher-create-fundingSafe').textContent).toMatch(/master Safe/);
  });

  it('shows projected tasks when balance + prices are valid', () => {
    render(
      <Step4ConfigurePricing
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
        fundingSafeAddress="0xSAFE"
        fundingSafeBalanceWei="1000000000000000000"
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-solutionPriceWei'), {
      target: { value: '100000000000000000' }, // 0.1 ETH
    });
    fireEvent.change(screen.getByTestId('launcher-create-verdictPriceWei'), {
      target: { value: '50000000000000000' }, // 0.05 ETH
    });
    expect(screen.getByTestId('launcher-create-projected-tasks').textContent).toContain('~6');
  });

  it('rejects both-zero on Next', () => {
    const onAdvance = vi.fn();
    render(
      <Step4ConfigurePricing
        draft={buildDraft()}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
        fundingSafeAddress="0xSAFE"
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-solutionPriceWei'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-verdictPriceWei'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).not.toHaveBeenCalled();
    expect(screen.getByTestId('launcher-create-pricing-combined-error').textContent).toMatch(
      /At least one price must be positive/,
    );
  });

  it('persists pricing and configurePricing step on Next', () => {
    const onAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <Step4ConfigurePricing
        draft={buildDraft({ completedSteps: ['define', 'reviewContract', 'configureGenerator'] })}
        template={PREDICTION_V1_TEMPLATE}
        onAdvance={onAdvance}
        onBack={() => undefined}
        fundingSafeAddress="0xSAFE"
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-solutionPriceWei'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-verdictPriceWei'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledWith({
      solutionPriceWei: '1000',
      verdictPriceWei: '500',
      completedSteps: ['define', 'reviewContract', 'configureGenerator', 'configurePricing'],
    });
  });

  it('uses the active template claimPolicyDefaults.maxClaimsPerOperator (swe-rebench-v2 = 5)', () => {
    render(
      <Step4ConfigurePricing
        draft={buildDraft({
          templateContractId: 'swe-rebench-v2',
          templateContractVersion: 'v1',
        })}
        template={SWE_REBENCH_V2_V1_TEMPLATE}
        onAdvance={() => undefined}
        onBack={() => undefined}
        fundingSafeAddress="0xSAFE"
        fundingSafeBalanceWei="11000"
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-create-solutionPriceWei'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-verdictPriceWei'), {
      target: { value: '200' },
    });
    // perTaskWei = 100 + 200 * 5 = 1100; 11000 / 1100 = 10 tasks
    expect(screen.getByTestId('launcher-create-projected-tasks').textContent).toContain('~10');
    // hint references 5
    const projection = screen.getByTestId('launcher-create-projection');
    expect(projection.textContent).toMatch(/maxClaimsPerOperator \(5\)/);
  });
});
