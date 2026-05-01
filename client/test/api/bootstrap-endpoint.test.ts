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
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
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
});
