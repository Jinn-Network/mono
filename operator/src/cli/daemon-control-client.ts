/**
 * Minimal authenticated HTTP client for CLI control-route front-ends
 * (spec §10 composition, tier 1: "Daemon up → the CLI reads the HTTP read
 * plane and mutates via control routes, exactly like the console").
 *
 * Talks to the daemon's own operator API over loopback, using the on-disk
 * UI token (`~/.jinn-client/ui-token`) via the `x-jinn-ui-token` header path
 * `requireUiToken` (api/handshake.ts) already accepts for non-browser
 * clients. A short timeout and any connection failure both resolve to
 * `reachable: false` rather than throwing — "no daemon listening here" is
 * an expected, not exceptional, outcome for a CLI verb that may run with
 * the daemon up or down.
 */
import { defaultTokenPath, resolveStoredUiToken } from '../api/ui-token.js';

/**
 * Resolve the on-disk UI token (`~/.jinn-client/ui-token` by default). Shared by every CLI
 * front-end that talks to the daemon's operator API — `postToDaemon` below,
 * `introspection-context.ts`'s `/v1/status` fetch, and `scripts/status.ts` (spec §10.1,
 * issue #2404) — so there is exactly one token-resolution path, not one per caller.
 */
export function resolveUiToken(tokenPath: string = defaultTokenPath()): string | undefined {
  return resolveStoredUiToken(tokenPath);
}

export interface DaemonPostResult<T> {
  reachable: boolean;
  status?: number;
  body?: T;
  error?: string;
}

export async function requestDaemon<T = unknown>(opts: {
  apiPort: number;
  path: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Overridable for tests; defaults to the real `~/.jinn-client/ui-token`. */
  tokenPath?: string;
}): Promise<DaemonPostResult<T>> {
  const token = resolveUiToken(opts.tokenPath);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000);
  try {
    const headers: Record<string, string> = {};
    if (token) headers['x-jinn-ui-token'] = token;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${opts.apiPort}${opts.path}`, {
      method: opts.method ?? 'POST',
      signal: ac.signal,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = (await res.json().catch(() => undefined)) as T | undefined;
    return { reachable: true, status: res.status, body };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function postToDaemon<T = unknown>(opts: {
  apiPort: number;
  path: string;
  timeoutMs?: number;
  tokenPath?: string;
}): Promise<DaemonPostResult<T>> {
  return requestDaemon<T>(opts);
}
