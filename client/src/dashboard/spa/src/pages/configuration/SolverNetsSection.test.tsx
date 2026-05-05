import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SolverNetsSection } from './SolverNetsSection.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getSolverNets: async () => ({
      schemaVersion: 1,
      generatedAt: '2026-05-04T12:00:00Z',
      nets: [
        {
          name: 'prediction',
          description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
          intrinsicSolverType: 'prediction.v1',
          state: 'live',
          supportedRoles: ['solving', 'evaluating'],
          compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] }],
          compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
        },
      ],
    }),
  },
}));

describe('SolverNetsSection', () => {
  it('renders the catalog under the section card', async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <SolverNetsSection
          configByName={{
            prediction: { enabled: false, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] },
          }}
          onSaved={() => undefined}
          onRestartPending={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('prediction')).toBeTruthy();
  });
});
