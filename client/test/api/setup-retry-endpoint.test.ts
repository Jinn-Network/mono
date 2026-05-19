/**
 * Tests for POST /v1/setup/bootstrap/retry — jinn-mono-hjex.6
 *
 * The endpoint re-enters the bootstrap state machine in-process so the
 * operator doesn't need to restart the daemon after a funding shortfall clears.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { addSetupRetryEndpoint } from '../../src/api/setup-retry-endpoint.js';

describe('POST /v1/setup/bootstrap/retry', () => {
  it('calls retryBootstrap and returns ok:true on success', async () => {
    const retryBootstrap = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();
    addSetupRetryEndpoint(app, { retryBootstrap });

    const res = await app.request('/v1/setup/bootstrap/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(retryBootstrap).toHaveBeenCalledOnce();
  });

  it('returns ok:false with 500 when retryBootstrap throws', async () => {
    const retryBootstrap = vi.fn().mockRejectedValue(new Error('bootstrap exploded'));
    const app = new Hono();
    addSetupRetryEndpoint(app, { retryBootstrap });

    const res = await app.request('/v1/setup/bootstrap/retry', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/bootstrap exploded/);
  });

  it('is idempotent — concurrent calls do not fork two state machines', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;

    const retryBootstrap = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    });

    const app = new Hono();
    addSetupRetryEndpoint(app, { retryBootstrap });

    // Fire two requests concurrently
    const [r1, r2] = await Promise.all([
      app.request('/v1/setup/bootstrap/retry', { method: 'POST' }),
      app.request('/v1/setup/bootstrap/retry', { method: 'POST' }),
    ]);

    // Both must succeed
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // retryBootstrap must never have been executing concurrently
    expect(maxConcurrent).toBe(1);
  });

  it('releases the idempotency lock after a failure so subsequent retries can proceed', async () => {
    let callCount = 0;
    const retryBootstrap = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient failure');
      // second call succeeds
    });

    const app = new Hono();
    addSetupRetryEndpoint(app, { retryBootstrap });

    // First call: fails
    const r1 = await app.request('/v1/setup/bootstrap/retry', { method: 'POST' });
    expect(r1.status).toBe(500);

    // Second call: should proceed (lock must have been released)
    const r2 = await app.request('/v1/setup/bootstrap/retry', { method: 'POST' });
    expect(r2.status).toBe(200);
    expect(retryBootstrap).toHaveBeenCalledTimes(2);
  });
});
