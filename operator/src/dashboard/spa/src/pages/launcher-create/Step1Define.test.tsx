import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Step1Define } from './Step1Define.js';
import type { DraftSolverNetRecord } from '../../../../../api/contract/index.js';

function buildDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'd1',
    completedSteps: [],
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

describe('Step1Define', () => {
  it('renders empty fields when the draft has no name/description', () => {
    render(<Step1Define draft={buildDraft()} onAdvance={() => undefined} />);
    const name = screen.getByTestId('launcher-create-name') as HTMLInputElement;
    const description = screen.getByTestId('launcher-create-description') as HTMLTextAreaElement;
    expect(name.value).toBe('');
    expect(description.value).toBe('');
  });

  it('pre-fills fields from an existing draft', () => {
    render(
      <Step1Define
        draft={buildDraft({ name: 'Polymarket', description: 'Forecast markets' })}
        onAdvance={() => undefined}
      />,
    );
    const name = screen.getByTestId('launcher-create-name') as HTMLInputElement;
    const description = screen.getByTestId('launcher-create-description') as HTMLTextAreaElement;
    expect(name.value).toBe('Polymarket');
    expect(description.value).toBe('Forecast markets');
  });

  it('disables Next when fields are empty', () => {
    const onAdvance = vi.fn();
    render(<Step1Define draft={buildDraft()} onAdvance={onAdvance} />);
    const next = screen.getByTestId('launcher-create-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('shows inline errors after the form is touched but blank', () => {
    const onAdvance = vi.fn();
    render(<Step1Define draft={buildDraft()} onAdvance={onAdvance} />);
    // Trigger touched by entering then clearing the name field.
    const name = screen.getByTestId('launcher-create-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'X' } });
    fireEvent.change(name, { target: { value: '' } });
    // Try clicking Next anyway — disabled, but we can still trigger the
    // submit codepath via Enter key inside the input.
    fireEvent.submit(name.closest('form')!);
    expect(screen.getByText(/Name is required/i)).toBeTruthy();
    expect(screen.getByText(/Description is required/i)).toBeTruthy();
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('calls onAdvance with trimmed name + description + completed step', async () => {
    const onAdvance = vi.fn().mockResolvedValue(undefined);
    render(<Step1Define draft={buildDraft()} onAdvance={onAdvance} />);
    fireEvent.change(screen.getByTestId('launcher-create-name'), {
      target: { value: '  Polymarket  ' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-description'), {
      target: { value: '  Forecast markets  ' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledWith({
      name: 'Polymarket',
      description: 'Forecast markets',
      completedSteps: ['define'],
    });
  });

  it('preserves existing completed steps and does not duplicate define', () => {
    const onAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <Step1Define
        draft={buildDraft({
          completedSteps: ['define', 'reviewContract'],
          name: 'Polymarket',
          description: 'Forecast markets',
        })}
        onAdvance={onAdvance}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    expect(onAdvance).toHaveBeenCalledWith(
      expect.objectContaining({ completedSteps: ['define', 'reviewContract'] }),
    );
  });

  it('renders the top-level error banner when a parent error is supplied', () => {
    render(
      <Step1Define
        draft={buildDraft()}
        onAdvance={() => undefined}
        error="Network blew up"
      />,
    );
    expect(screen.getByTestId('launcher-create-error').textContent).toContain('Network blew up');
  });
});
