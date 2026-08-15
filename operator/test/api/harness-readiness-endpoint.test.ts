import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { addHarnessReadinessRoutes } from '../../src/api/harness-readiness-endpoint.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness } from '../../src/harnesses/types.js';

function fixtureRegistry(): HarnessReadinessRegistry {
  const claude: Harness = {
    name: 'claude-code-learner',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: async () => ({ ready: true, reason: 'ok' }),
  };
  const evaluator: Harness = {
    name: 'swe-rebench-v2-evaluator',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: async () => ({
      ready: false,
      reason: 'docker not running',
      nextStep: { description: 'Start Docker', cli: 'open -a Docker' },
    }),
  };
  return new HarnessReadinessRegistry({
    harnessesByName: {
      'claude-code-learner': claude,
      'swe-rebench-v2-evaluator': evaluator,
    },
    joinedHarnessesByCid: {
      'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      'bafkrei.eval': { harnessName: 'swe-rebench-v2-evaluator', roles: ['evaluator'] },
    },
  });
}

describe('harness-readiness-endpoint', () => {
  it('GET /v1/harnesses/readiness returns composed snapshot', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/readiness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.harnesses).toHaveLength(2);
    expect(body.lastRefreshedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('GET /v1/harnesses/:name/readiness returns single-harness snapshot', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/claude-code-learner/readiness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.harnessName).toBe('claude-code-learner');
    expect(body.ready).toBe(true);
  });

  it('GET /v1/harnesses/:name/readiness returns 404 for unknown harness', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/no-such-harness/readiness');
    expect(res.status).toBe(404);
  });
});
