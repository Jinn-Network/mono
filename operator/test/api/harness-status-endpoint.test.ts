import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addHarnessStatusRoutes } from '../../src/api/harness-status-endpoint.js';

describe('GET /api/harness/status', () => {
  it('returns the configured mode + computed codeDigest', async () => {
    const app = new Hono();
    addHarnessStatusRoutes(app, {
      getStatus: async () => ({
        mode: 'train',
        codeDigest: 'sha256:abc123',
      }),
    });
    const res = await app.request('/api/harness/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      codeDigest: string;
      lastModeSwitchAt?: number;
    };
    expect(body.mode).toBe('train');
    expect(body.codeDigest).toBe('sha256:abc123');
    expect(body.lastModeSwitchAt).toBeUndefined();
  });

  it('includes lastModeSwitchAt when present', async () => {
    const app = new Hono();
    addHarnessStatusRoutes(app, {
      getStatus: async () => ({
        mode: 'frozen',
        codeDigest: 'sha256:def456',
        lastModeSwitchAt: 1_746_547_200_000,
      }),
    });
    const res = await app.request('/api/harness/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      codeDigest: string;
      lastModeSwitchAt?: number;
    };
    expect(body.mode).toBe('frozen');
    expect(body.lastModeSwitchAt).toBe(1_746_547_200_000);
  });

  it('returns 500 if the deps throw', async () => {
    const app = new Hono();
    addHarnessStatusRoutes(app, {
      getStatus: async () => {
        throw new Error('implStateDir not initialized');
      },
    });
    const res = await app.request('/api/harness/status');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('harness_status_failed');
  });
});
