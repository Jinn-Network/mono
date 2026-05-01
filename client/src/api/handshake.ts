/**
 * /auth/handshake — exchanges a daemon-printed handshake key for a UI session
 * cookie. The daemon prints the URL `http://127.0.0.1:<port>/auth/handshake?k=<key>`
 * on startup; the launcher (Task 19) opens the browser at that URL on first
 * load. Subsequent requests carry the `jinn_ui_token` cookie.
 *
 * `requireUiToken` is a Hono middleware factory: protected routes mount it
 * with the daemon's current token, and the middleware accepts either the
 * cookie or an `x-jinn-ui-token` header (for non-browser clients).
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';

export interface HandshakeConfig {
  token: string;
  handshakeKey: string;
}

export function addHandshakeRoutes(app: Hono, cfg: HandshakeConfig): void {
  app.get('/auth/handshake', (c) => {
    const k = c.req.query('k');
    if (!k || k !== cfg.handshakeKey) {
      return c.json({ error: 'invalid_handshake_key' }, 401);
    }
    setCookie(c, 'jinn_ui_token', cfg.token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true });
  });
}

export function requireUiToken(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, 'jinn_ui_token');
    const header = c.req.header('x-jinn-ui-token');
    const supplied = cookie ?? header;
    if (!supplied || supplied !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
