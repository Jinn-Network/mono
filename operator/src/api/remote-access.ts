/**
 * §9 remote-access gate (spec/2026-08-04-headless-operator-rederivation-design.md).
 *
 * Operator-class responses to a non-loopback peer require attested TLS from a
 * declared trusted proxy (`X-Forwarded-Proto: https` + last XFF hop in
 * `apiTrustedProxies`) or an explicit `apiInsecureRemote: true`. Loopback is
 * always allowed. Public liveness/readiness/metrics, handshake, GET `/`
 * (no-human-surface 404), and CORS preflight are not operator-class.
 */
import type { Context, MiddlewareHandler } from 'hono';

export interface RemoteAccessConfig {
  apiInsecureRemote: boolean;
  apiTrustedProxies: readonly string[];
}

export function isLoopbackAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
  if (h.startsWith('127.')) return true;
  if (h === '::ffff:127.0.0.1' || h.startsWith('::ffff:127.')) return true;
  return false;
}

export function isPublicOperatorPath(path: string): boolean {
  if (path === '/health' || path === '/ready' || path === '/metrics') return true;
  if (path === '/auth/handshake') return true;
  if (path === '/' || path.startsWith('/assets/')) return true;
  if (path.startsWith('/artifacts')) return true;
  if (path === '/api/stop-hook') return true;
  return false;
}

function forwardedHops(c: Context): string[] {
  const xff = c.req.header('x-forwarded-for');
  if (!xff) return [];
  return xff.split(',').map((hop) => hop.trim()).filter(Boolean);
}

export function peerIsLoopback(c: Context): boolean {
  const hops = forwardedHops(c);
  if (hops.length === 0) return true;
  return isLoopbackAddress(hops[0]!);
}

export function remoteAccessAllowed(c: Context, cfg: RemoteAccessConfig): boolean {
  if (peerIsLoopback(c)) return true;
  if (cfg.apiInsecureRemote) return true;
  const proto = (c.req.header('x-forwarded-proto') ?? '').toLowerCase();
  if (proto !== 'https') return false;
  const hops = forwardedHops(c);
  const proxy = hops[hops.length - 1];
  return Boolean(proxy && cfg.apiTrustedProxies.includes(proxy));
}

export function requireRemoteAccess(cfg: RemoteAccessConfig): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (isPublicOperatorPath(c.req.path)) return next();
    if (remoteAccessAllowed(c, cfg)) return next();
    return c.json({ error: 'remote_access_disabled' }, 403);
  };
}

export const DEFAULT_API_CORS_ORIGINS = [
  'http://127.0.0.1:3000',
  'http://localhost:3000',
] as const;
