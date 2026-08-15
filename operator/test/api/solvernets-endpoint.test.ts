import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { addSolverNetsRoutes } from '../../src/api/solvernets-endpoint.js';

describe('GET /v1/solvernets', () => {
  it('returns the catalog from the registered list', async () => {
    const app = new Hono();
    addSolverNetsRoutes(app, {
      registry: {
        list: () => [
          {
            name: 'prediction',
            description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
            contract: { id: 'prediction', version: 'v1' },
            state: 'live' as const,
            supportedRoles: ['solving' as const, 'evaluating' as const],
            compatibleHarnesses: [],
            compatiblePlugins: [],
          },
        ],
      },
    });
    const res = await app.request('/v1/solvernets');
    expect(res.status).toBe(200);
    const body = await res.json() as { schemaVersion: number; nets: Array<{ name: string }> };
    expect(body.schemaVersion).toBe(1);
    expect(body.nets.map((n) => n.name)).toEqual(['prediction']);
  });
});
