import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NetCard } from './NetCard.js';

const apiMock = vi.hoisted(() => ({
  updateSolverNet: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  api: {
    updateSolverNet: apiMock.updateSolverNet,
  },
}));

const baseCatalog = {
  name: 'prediction',
  description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
  intrinsicSolverType: 'prediction.v1',
  state: 'live' as const,
  supportedRoles: ['solving' as const, 'evaluating' as const],
  compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] }],
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
        config={{ enabled: false, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText('prediction')).toBeTruthy();
    expect(screen.getByText(/forecast resolved outcomes/i)).toBeTruthy();
    expect(screen.getByText(/available/i)).toBeTruthy();
  });

  it('expands the body when enabled and shows Solving role active', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: true, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: ['jinn-prediction-plugin'] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText(/live/i)).toBeTruthy();
    const solving = screen.getByText('Solving').closest('button');
    expect(solving?.getAttribute('data-role-active')).toBe('true');
  });

  it('does not persist the displayed fallback model when saving another field', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: false,
          role: 'solving',
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

  it('persists the model when the operator edits the fallback value', async () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{
          enabled: true,
          role: 'solving',
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          modelExplicit: false,
          plugins: [],
        }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('claude-haiku-4-5-20251001'), {
      target: { value: 'claude-sonnet-4-5-20250929' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiMock.updateSolverNet).toHaveBeenCalled());
    expect(apiMock.updateSolverNet).toHaveBeenCalledWith('prediction', expect.objectContaining({
      model: 'claude-sonnet-4-5-20250929',
    }));
  });
});
