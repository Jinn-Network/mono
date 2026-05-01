import type {
  BootstrapState,
  ClaudeAuthState,
  StructuredEvent,
} from './types.js';

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getStatus: () => jfetch<unknown>('/v1/status'),
  getBootstrap: () => jfetch<BootstrapState>('/v1/bootstrap'),
  getRecentEvents: (kinds?: string[], limit = 100) => {
    const q = new URLSearchParams();
    if (kinds && kinds.length > 0) q.set('kinds', kinds.join(','));
    q.set('limit', String(limit));
    return jfetch<{ events: StructuredEvent[] }>(`/v1/events/recent?${q.toString()}`);
  },
  getClaudeAuth: () => jfetch<ClaudeAuthState>('/v1/auth/claude'),
  signInClaude: () =>
    jfetch<{ ok: boolean; reason?: string }>('/v1/auth/claude/spawn', {
      method: 'POST',
    }),
  triggerDrip: () =>
    jfetch<{
      ok: boolean;
      address?: string;
      txHash?: string;
      txHashes?: string[];
      attempts?: number;
      balanceWei?: string;
      targetWei?: string;
      reason?: string;
      rateLimited?: boolean;
    }>(
      '/v1/setup/drip',
      { method: 'POST' },
    ),
  changeKeystorePassword: (current: string, next: string) =>
    jfetch<{ ok: boolean }>('/v1/setup/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current, next }),
    }),
  claimRewards: () =>
    jfetch<{ ok: boolean; result?: unknown; exitCode?: number | null; error?: string }>(
      '/api/admin/claim-rewards',
      { method: 'POST' },
    ),
  restartDaemon: () =>
    jfetch<{ ok: boolean; scheduled?: boolean }>('/api/admin/restart', {
      method: 'POST',
    }),
};

/**
 * On first load, the daemon prints a handshake URL with `?k=<key>` that the
 * launcher opens in the browser. The SPA picks up that key, exchanges it for
 * a `jinn_ui_token` cookie, then strips the param so refreshes work without it.
 *
 * Subsequent loads (no `?k=` in URL) silently no-op; the cookie is reused.
 */
export async function ensureSessionToken(): Promise<void> {
  const url = new URL(window.location.href);
  const k = url.searchParams.get('k');
  if (!k) return;
  try {
    await fetch(`/auth/handshake?k=${encodeURIComponent(k)}`, { credentials: 'same-origin' });
  } catch {
    // best-effort: if handshake fails we'll still render; later API calls will 401
  }
  url.searchParams.delete('k');
  window.history.replaceState({}, '', url.toString());
}
