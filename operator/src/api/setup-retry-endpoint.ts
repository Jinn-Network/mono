/**
 * POST /v1/setup/bootstrap/retry — jinn-mono-hjex.6
 *
 * Re-enters the bootstrap state machine in-process without requiring a daemon
 * restart. Idempotent: concurrent calls coalesce onto the single in-flight
 * attempt rather than forking two state machines.
 *
 * Thin front-end over `intents/bootstrap-retry.ts` per spec §4.1/§11 — the
 * CLI verb (`cli/commands/bootstrap-retry.ts`) is the other front-end,
 * calling the same intent over this route (it cannot invoke it in-process;
 * see that module's docstring). The per-route in-flight coalescing below
 * predates the intent extraction and stays here — it protects THIS route
 * instance against concurrent callers, which is a route-level concern the
 * intent module (stateless, one call in / one result out) doesn't own.
 */
import type { Hono } from 'hono';
import { bootstrapRetryIntent, type BootstrapRetryIntentResult } from '../intents/bootstrap-retry.js';

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

export function addSetupRetryEndpoint(app: Hono, deps: SetupRetryDeps): void {
  // In-flight promise for idempotency: concurrent POST /retry calls share the
  // same bootstrap attempt rather than forking two state machines.
  let inFlight: Promise<BootstrapRetryIntentResult> | null = null;

  app.post('/v1/setup/bootstrap/retry', async (c) => {
    if (!inFlight) {
      inFlight = bootstrapRetryIntent({ retryBootstrap: deps.retryBootstrap }).finally(() => {
        inFlight = null;
      });
    }

    const result = await inFlight;
    if (result.ok) {
      return c.json({ ok: true });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });
}
