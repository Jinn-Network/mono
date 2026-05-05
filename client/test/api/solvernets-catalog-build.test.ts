import { describe, expect, it } from 'vitest';
import { buildSolverNetsCatalog } from '../../src/api/solvernets-catalog-build.js';

describe('buildSolverNetsCatalog', () => {
  it('emits one entry per registered SolverNet with name, description, state, supported roles, and intrinsic solverType', () => {
    const catalog = buildSolverNetsCatalog({
      registered: [
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
    });
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.nets).toHaveLength(1);
    expect(catalog.nets[0]).toMatchObject({
      name: 'prediction',
      state: 'live',
      intrinsicSolverType: 'prediction.v1',
      supportedRoles: ['solving', 'evaluating'],
    });
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns an empty list when no SolverNets are registered', () => {
    const catalog = buildSolverNetsCatalog({ registered: [] });
    expect(catalog.nets).toEqual([]);
  });
});
