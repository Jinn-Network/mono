import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addBootstrapRoutes } from '../../src/api/bootstrap-endpoint.js';
import { buildEnvelope } from '../../src/errors/envelope.js';
import { persistBootstrapError } from '../../src/errors/persisted-bootstrap-error.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFixtureEarningDir(state: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'earning_state.json'), JSON.stringify(state));
  return dir;
}

describe('GET /v1/bootstrap', () => {
  it('returns the current bootstrap step + per-step status when state file exists', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'awaiting_funding', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
  });

  it('returns mode=running when all services are complete', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('running');
  });

  it('returns mode=running when a service is operational but identity binding is pending', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'safe_binding_pending', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string; currentStep: string };
    expect(body.mode).toBe('running');
    expect(body.currentStep).toBe('safe_binding_pending');
  });

  it('returns mode=uninitialized when no state file exists', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-empty-'));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('uninitialized');
  });

  it('reports awaiting_funding after master wallet creation before service rows exist', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(0);
  });

  it('exposes funding balance/target on a fresh fleet (services=[]) so the SPA can render real progress', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), JSON.stringify({
      schemaVersion: 1,
      master_address: '0xabc',
      eth_required: '10000000000000000',
      eth_balance: '0',
    }));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      funding?: { eth_required?: string; eth_balance?: string; targetWei?: string };
    };
    expect(body.mode).toBe('setup');
    expect(body.funding).toMatchObject({
      eth_required: '10000000000000000',
      eth_balance: '0',
      targetWei: '10000000000000000',
    });
  });

  it('reports awaiting_funding when the daemon persists a funding gate during a partial bootstrap', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'staked', safe_address: '0xsafe' }],
    });
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), JSON.stringify({
      schemaVersion: 1,
      master_address: '0xabc',
      eth_required: '1',
      eth_balance: '0',
    }));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      currentStep: string;
      services: unknown[];
      funding?: { eth_required?: string; eth_balance?: string; targetWei?: string };
    };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
    expect(body.funding).toMatchObject({
      eth_required: '1',
      eth_balance: '0',
      targetWei: '1',
    });
  });

  it('surfaces persisted bootstrap-error.json envelope so the panel can render the failure', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    const env = buildEnvelope({
      code: 'fatal',
      message: 'stOLAS stake() tx failed for service 1: 0xdeadbeef',
      hint: 'Bootstrap failed before the fleet reached a runnable state.',
      details: { cause: 'NoRewardsAvailable' },
    });
    persistBootstrapError(env, earningDir);

    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      error?: { code: string; message: string; exitCode: number; details?: unknown };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe('fatal');
    expect(body.error!.exitCode).toBe(50);
    expect(body.error!.message).toContain('stOLAS stake() tx failed');
    expect(body.error!.details).toEqual({ cause: 'NoRewardsAvailable' });
  });

  it('omits the error field when no bootstrap-error.json is present', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { error?: unknown };
    expect(body.error).toBeUndefined();
  });

  it('includes rpcUrl, defaultRpcUrl, solverNets, and joinedSolverNets when configReader is supplied', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        rpcUrl: 'https://my-tenderly.example/abc',
        defaultRpcUrl: 'https://sepolia.base.org',
        solverNets: { prediction: { enabled: true, role: 'solving' } },
        joinedSolverNets: {
          bafkreiswe: { name: 'SWE-rebench v2', roles: ['solver', 'evaluator'] },
        },
      }),
    });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rpcUrl?: string;
      defaultRpcUrl?: string;
      solverNets?: Record<string, unknown>;
      joinedSolverNets?: Record<string, unknown>;
    };
    expect(body.rpcUrl).toBe('https://my-tenderly.example/abc');
    expect(body.defaultRpcUrl).toBe('https://sepolia.base.org');
    expect(body.solverNets).toMatchObject({ prediction: { enabled: true, role: 'solving' } });
    expect(body.joinedSolverNets).toMatchObject({
      bafkreiswe: { name: 'SWE-rebench v2', roles: ['solver', 'evaluator'] },
    });
  });
});
