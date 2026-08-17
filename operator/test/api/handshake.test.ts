import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addHandshakeRoutes, requireUiToken } from '../../src/api/handshake.js';

describe('/auth/handshake', () => {
  it('returns 200 + sets cookie when handshake key matches', async () => {
    const token = 'tok_test_1234567890abcdef1234567890abcdef';
    const handshakeKey = 'hs_test_key';
    const app = new Hono();
    addHandshakeRoutes(app, { token, handshakeKey });
    const res = await app.request(`/auth/handshake?k=${handshakeKey}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(res.headers.get('Set-Cookie')).toContain('jinn_ui_token=');
  });

  it('returns 401 when handshake key is missing or wrong', async () => {
    const app = new Hono();
    addHandshakeRoutes(app, { token: 't', handshakeKey: 'right' });
    const wrong = await app.request('/auth/handshake?k=wrong');
    expect(wrong.status).toBe(401);
    const missing = await app.request('/auth/handshake');
    expect(missing.status).toBe(401);
  });

  it('requireUiToken accepts valid cookie', async () => {
    const app = new Hono();
    app.use('/protected', requireUiToken('correct-token'));
    app.get('/protected', (c) => c.json({ ok: true }));
    const ok = await app.request('/protected', {
      headers: { cookie: 'jinn_ui_token=correct-token' },
    });
    expect(ok.status).toBe(200);
  });

  it('requireUiToken rejects missing token', async () => {
    const app = new Hono();
    app.use('/protected', requireUiToken('correct-token'));
    app.get('/protected', (c) => c.json({ ok: true }));
    const fail = await app.request('/protected');
    expect(fail.status).toBe(401);
  });

  it('requireUiToken accepts header alternative', async () => {
    const app = new Hono();
    app.use('/protected', requireUiToken('correct-token'));
    app.get('/protected', (c) => c.json({ ok: true }));
    const ok = await app.request('/protected', {
      headers: { 'x-jinn-ui-token': 'correct-token' },
    });
    expect(ok.status).toBe(200);
  });

  it('requireUiToken rejects an expired token even when the secret matches', async () => {
    const app = new Hono();
    app.use(
      '/protected',
      requireUiToken({ token: 'correct-token', expiresAt: '2020-01-01T00:00:00.000Z' }),
    );
    app.get('/protected', (c) => c.json({ ok: true }));
    const fail = await app.request('/protected', {
      headers: { 'x-jinn-ui-token': 'correct-token' },
    });
    expect(fail.status).toBe(401);
  });

  it('requireUiToken rejects a different-length secret without throwing', async () => {
    const app = new Hono();
    app.use('/protected', requireUiToken('correct-token'));
    app.get('/protected', (c) => c.json({ ok: true }));
    const fail = await app.request('/protected', {
      headers: { 'x-jinn-ui-token': 'short' },
    });
    expect(fail.status).toBe(401);
  });
});
