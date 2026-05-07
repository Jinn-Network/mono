import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Step2ReviewContract } from './Step2ReviewContract.js';
import type { DraftSolverNetRecord } from '../../api/types.js';

function buildDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'd1',
    name: 'Polymarket',
    description: 'Forecast markets',
    completedSteps: ['define'],
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

describe('Step2ReviewContract', () => {
  it('renders the prediction.v1 template details read-only', () => {
    render(
      <Step2ReviewContract
        draft={buildDraft()}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    const card = screen.getByTestId('launcher-create-template');
    expect(card.getAttribute('data-template-id')).toBe('prediction.v1');
    expect(screen.getByText(/Prediction/)).toBeTruthy();
    expect(screen.getByText(/prediction\.brier-loss\.v1/)).toBeTruthy();
    expect(screen.getByText(/prediction\.trailing-mean-brier-spread\.v1/)).toBeTruthy();
    // claim policy: parallel mode + 25 max claims
    expect(screen.getByText(/parallel/)).toBeTruthy();
    expect(screen.getByText('25')).toBeTruthy();
  });

  it('renders credential requirements per role', () => {
    render(
      <Step2ReviewContract
        draft={buildDraft()}
        onAdvance={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-create-credentials-creator')).toBeTruthy();
    expect(screen.getByTestId('launcher-create-credentials-solver')).toBeTruthy();
    expect(screen.getByTestId('launcher-create-credentials-evaluator')).toBeTruthy();
    // solver has no creds in prediction.v1 — renders "None."
    const solverPanel = screen.getByTestId('launcher-create-credentials-solver');
    expect(solverPanel.textContent).toMatch(/None\./);
  });

  it('Next records template id+version + reviewContract step', () => {
    const onAdvance = vi.fn();
    render(
      <Step2ReviewContract
        draft={buildDraft({ completedSteps: ['define'] })}
        onAdvance={onAdvance}
        onBack={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledWith({
      templateContractId: 'prediction',
      templateContractVersion: 'v1',
      completedSteps: ['define', 'reviewContract'],
    });
  });

  it('Back invokes onBack', () => {
    const onBack = vi.fn();
    render(
      <Step2ReviewContract
        draft={buildDraft()}
        onAdvance={() => undefined}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-back'));
    expect(onBack).toHaveBeenCalled();
  });
});
