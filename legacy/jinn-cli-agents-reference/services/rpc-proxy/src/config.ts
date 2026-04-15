/** Public RPCs only — never commit gateway URLs with embedded access keys. */
const DEFAULT_UPSTREAMS = ['https://mainnet.base.org'];

export interface ProxyConfig {
  port: number;
  bearerToken: string | null;
  upstreamUrls: string[];
  healthCheckIntervalMs: number;
  requestTimeoutMs: number;
}

export function loadConfig(): ProxyConfig {
  const token = process.env.RPC_PROXY_BEARER_TOKEN || null;

  const raw = process.env.RPC_UPSTREAM_URLS || '';
  const upstreamUrls = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Fall back to public RPCs if no upstreams configured (set RPC_UPSTREAM_URLS for Tenderly/dRPC/etc.)
  if (upstreamUrls.length === 0) {
    upstreamUrls.push(...DEFAULT_UPSTREAMS);
  }

  if (!token) {
    console.warn('[rpc-proxy] RPC_PROXY_BEARER_TOKEN not set — running without auth');
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    bearerToken: token,
    upstreamUrls,
    healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
  };
}
