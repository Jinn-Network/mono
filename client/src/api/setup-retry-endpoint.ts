/**
 * POST /v1/setup/bootstrap/retry — jinn-mono-hjex.6
 *
 * Re-enters the bootstrap state machine in-process without requiring a daemon
 * restart. Idempotent: concurrent calls coalesce onto the single in-flight
 * attempt rather than forking two state machines.
 */
import type { Hono } from 'hono';

export interface SetupRetryDeps {
  /**
   * Closure that re-runs the bootstrap state machine.
   * - Resolves when bootstrap completes successfully.
   * - Rejects with the most-recent error if it fails (non-funding errors
   *   surface immediately; funding shortfalls are surfaced as rejections once
   *   the caller gives up).
   */
  retryBootstrap: () => Promise<void>;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function addSetupRetryEndpoint(app: Hono, deps: SetupRetryDeps): void {
  // In-flight promise for idempotency: concurrent POST /retry calls share the
  // same bootstrap attempt rather than forking two state machines.
  let inFlight: Promise<void> | null = null;

  app.post('/v1/setup/bootstrap/retry', async (c) => {
    if (!inFlight) {
      inFlight = deps.retryBootstrap().finally(() => {
        inFlight = null;
      });
    }

    try {
      await inFlight;
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: serializeError(err) }, 500);
    }
  });
}
