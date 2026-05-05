import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addAgentBindingRoutes } from '../../src/api/agent-binding-endpoint.js';

describe('POST /v1/setup/agent-binding/retry', () => {
  it('runs the bind step for each unbound service and reports per-service status', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) => ({
      serviceIndex,
      status: 'success' as const,
      txHash: `0x${'aa'.repeat(32)}`,
    }));
    const listUnbound = vi.fn(async () => [{ serviceIndex: 1 }, { serviceIndex: 2 }]);

    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });

    const res = await app.request('/v1/setup/agent-binding/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; attempts: Array<{ serviceIndex: number; status: string }> };
    expect(body.ok).toBe(true);
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]?.status).toBe('success');
  });

  it('returns 200 with an empty attempts array when nothing is unbound', async () => {
    const retryBind = vi.fn();
    const listUnbound = vi.fn(async () => []);
    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });
    const res = await app.request('/v1/setup/agent-binding/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: unknown[] };
    expect(body.attempts).toEqual([]);
    expect(retryBind).not.toHaveBeenCalled();
  });

  it('targets only the requested serviceIndex when supplied', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) => ({
      serviceIndex,
      status: 'reverted' as const,
      detail: 'execution reverted',
    }));
    const listUnbound = vi.fn();

    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });

    const res = await app.request('/v1/setup/agent-binding/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceIndex: 3 }),
    });
    expect(res.status).toBe(200);
    expect(retryBind).toHaveBeenCalledWith(3);
    expect(listUnbound).not.toHaveBeenCalled();
  });

  it('rejects a non-integer serviceIndex', async () => {
    const retryBind = vi.fn();
    const listUnbound = vi.fn();
    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });
    const res = await app.request('/v1/setup/agent-binding/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceIndex: 'one' }),
    });
    expect(res.status).toBe(400);
    expect(retryBind).not.toHaveBeenCalled();
  });
});
