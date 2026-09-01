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

describe('POST /v1/setup/agent-binding/retry — detail sanitization (#3036)', () => {
  it('masks an RPC URL in the failure detail down to its host', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) => ({
      serviceIndex,
      status: 'reverted' as const,
      detail:
        'HTTP request failed.\nURL: https://user:s3cret@rpc.example.com/v2/API_KEY_123?token=abc#frag\nDetails: 429',
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
    const body = (await res.json()) as { attempts: Array<{ detail?: string }> };
    const detail = body.attempts[0]?.detail ?? '';
    expect(detail).toContain('rpc.example.com');
    expect(detail).not.toContain('API_KEY_123');
    expect(detail).not.toContain('s3cret');
    expect(detail).not.toContain('token=abc');
    expect(detail).not.toContain('frag');
    // Non-URL context survives so the operator can still act on it.
    expect(detail).toContain('429');
  });

  it('leaves a detail with no URL untouched and omits an absent detail', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) =>
      serviceIndex === 1
        ? { serviceIndex, status: 'reverted' as const, detail: 'execution reverted' }
        : { serviceIndex, status: 'success' as const, txHash: `0x${'aa'.repeat(32)}` },
    );
    const listUnbound = vi.fn(async () => [{ serviceIndex: 1 }, { serviceIndex: 2 }]);

    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });

    const res = await app.request('/v1/setup/agent-binding/retry', { method: 'POST' });
    const body = (await res.json()) as { attempts: Array<{ detail?: string; txHash?: string }> };
    expect(body.attempts[0]?.detail).toBe('execution reverted');
    expect(body.attempts[1]).not.toHaveProperty('detail');
    expect(body.attempts[1]?.txHash).toBe(`0x${'aa'.repeat(32)}`);
  });
});
