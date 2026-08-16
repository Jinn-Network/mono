import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  DEFAULT_API_CORS_ORIGINS,
  requireRemoteAccess,
} from '../../src/api/remote-access.js';

function app(opts: { apiInsecureRemote?: boolean; apiTrustedProxies?: string[]; corsOrigins?: readonly string[] } = {}) {
  const hono = new Hono();
  const origins = [...(opts.corsOrigins ?? DEFAULT_API_CORS_ORIGINS)];
  hono.use(async (c, next) =>
    cors({
      origin: (origin) => (origin && origins.includes(origin) ? origin : ''),
      credentials: false,
    })(c, next),
  );
  hono.use(
    requireRemoteAccess({
      apiInsecureRemote: opts.apiInsecureRemote ?? false,
      apiTrustedProxies: opts.apiTrustedProxies ?? [],
    }),
  );
  hono.get('/v1/status', (c) => c.json({ ok: true }));
  hono.get('/health', (c) => c.json({ status: 'ok' }));
  return hono;
}

describe('remote-access gate (§9)', () => {
  it('allows loopback operator-class requests', async () => {
    const res = await app().request('/v1/status');
    expect(res.status).toBe(200);
  });

  it('rejects a public peer with no opt-in', async () => {
    const res = await app().request('/v1/status', {
      headers: {
        Host: 'daemon.example',
        'X-Forwarded-For': '203.0.113.50',
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'remote_access_disabled' });
  });

  it('admits a public peer when apiInsecureRemote is true', async () => {
    const res = await app({ apiInsecureRemote: true }).request('/v1/status', {
      headers: {
        Host: 'daemon.example',
        'X-Forwarded-For': '203.0.113.50',
      },
    });
    expect(res.status).toBe(200);
  });

  it('admits a public peer behind a trusted proxy with https proto', async () => {
    const res = await app({ apiTrustedProxies: ['10.0.0.2'] }).request('/v1/status', {
      headers: {
        Host: 'daemon.example',
        'X-Forwarded-For': '203.0.113.50, 10.0.0.2',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(res.status).toBe(200);
  });

  it('leaves /health unauthenticated-safe even from a public peer', async () => {
    const res = await app().request('/health', {
      headers: { 'X-Forwarded-For': '203.0.113.50' },
    });
    expect(res.status).toBe(200);
  });

  it('echoes an allowlisted CORS origin and does not send credentials', async () => {
    const res = await app().request('/v1/status', {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:3000');
    expect(res.headers.get('Access-Control-Allow-Credentials')).not.toBe('true');
  });

  it('does not echo a non-allowlisted CORS origin', async () => {
    const res = await app().request('/v1/status', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
  });
});
