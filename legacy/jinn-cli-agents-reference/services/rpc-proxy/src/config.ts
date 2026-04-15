const DEFAULT_UPSTREAMS = [
  'https://base.gateway.tenderly.co/6g74EyOoSgvpbSiU9h4mzl',
  'https://lb.drpc.live/base/AqIPPjb6i02njkMtTVCNr_73pTBmFIsR8ZsZtuZZzRRv',
  'https://mainnet.base.org',
];

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

  // Fall back to free public RPCs if no upstreams configured
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
