interface UpstreamState {
  url: string;
  healthy: boolean;
  failedAt: number | null;
}

export class UpstreamPool {
  private states: UpstreamState[];
  private cooldownMs: number;
  private timeoutMs: number;

  constructor(urls: string[], cooldownMs = 30_000, timeoutMs = 10_000) {
    this.states = urls.map((url) => ({ url, healthy: true, failedAt: null }));
    this.cooldownMs = cooldownMs;
    this.timeoutMs = timeoutMs;
  }

  private isAvailable(state: UpstreamState): boolean {
    if (state.healthy) return true;
    // Re-enable after cooldown expires
    if (state.failedAt && Date.now() - state.failedAt > this.cooldownMs) {
      state.healthy = true;
      state.failedAt = null;
      return true;
    }
    return false;
  }

  async tryRequest(body: string): Promise<Response> {
    const available = this.states.filter((s) => this.isAvailable(s));
    // If all are unhealthy, try them all anyway
    const candidates = available.length > 0 ? available : this.states;

    let lastError: Error | null = null;

    for (const state of candidates) {
      try {
        const res = await fetch(state.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // 4xx from the RPC node is a valid response (e.g. invalid method), not a failover trigger
        if (res.ok || res.status < 500) {
          return res;
        }

        throw new Error(`Upstream ${maskUrl(state.url)} returned ${res.status}`);
      } catch (err: any) {
        console.warn(`[rpc-proxy] Upstream ${maskUrl(state.url)} failed: ${err.message}`);
        state.healthy = false;
        state.failedAt = Date.now();
        lastError = err;
      }
    }

    throw lastError || new Error('All upstreams failed');
  }

  async healthCheck(): Promise<void> {
    const probe = JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
      id: 1,
    });

    await Promise.allSettled(
      this.states.map(async (state) => {
        try {
          const res = await fetch(state.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: probe,
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            state.healthy = true;
            state.failedAt = null;
          }
        } catch {
          // Leave health state unchanged — the main request path will downgrade it
        }
      }),
    );
  }

  getStatus() {
    return this.states.map((s) => ({
      url: maskUrl(s.url),
      healthy: s.healthy,
      failedAt: s.failedAt,
    }));
  }
}

/** Mask long tokens/keys in upstream URLs for safe logging */
function maskUrl(url: string): string {
  return url.replace(/\/[a-zA-Z0-9_-]{20,}/g, '/***');
}
