import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { addClaimPolicyRoutes } from '../../src/api/claim-policy-endpoints.js';

function app(config: Record<string, unknown> = {}) {
  const hono = new Hono();
  addClaimPolicyRoutes(hono, {
    configPath: '/tmp/config.json',
    readConfig: () =>
      ({
        claimPolicy: { mode: 'claim-nothing', spendCapWei: '0', aiUnitCap: 0 },
        executionWiring: [],
      }) as never,
    writeConfig: vi.fn(),
    ...config,
  } as never);
  return hono;
}

describe('claim policy endpoints', () => {
  it('returns the current policy and wiring', async () => {
    const response = await app().request('/v1/operator/claim-policy');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimPolicy: { mode: 'claim-nothing', spendCapWei: '0', aiUnitCap: 0 },
      executionWiring: [],
      restartRequired: false,
    });
  });

  it('writes an accepted policy atomically and reports restart-required', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/claim-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claimPolicy: { mode: 'every-runnable', spendCapWei: '10', aiUnitCap: 5 },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restartRequired: true });
    expect(writeConfig).toHaveBeenCalledOnce();
  });

  it('rejects a malformed policy with 400 and writes nothing', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/claim-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimPolicy: { mode: 'nope', spendCapWei: '0x1', aiUnitCap: -1 } }),
    });
    expect(response.status).toBe(400);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('writes an accepted execution wiring list atomically and reports restart-required', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/execution-wiring', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        executionWiring: [
          {
            workKind: 'QmSolver',
            harness: 'claude-code',
            model: 'claude-haiku-4-5-20251001',
            plugins: [],
            credentialRef: 'claude-code-default',
            isolationPolicy: 'process',
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restartRequired: true });
    expect(writeConfig).toHaveBeenCalledOnce();
  });

  it('rejects a malformed execution wiring body with 400 and writes nothing', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/execution-wiring', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executionWiring: [{ workKind: '' }] }),
    });
    expect(response.status).toBe(400);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
