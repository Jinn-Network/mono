/**
 * Bootstrap-retry intent module.
 *
 * Per spec §4.1/§11 (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md),
 * a control route is a thin front-end over a pure intent module — this
 * copies `intents/claim-rewards.ts`'s shape: config/deps in, structured
 * result out, no `CommandContext`, no argv parsing.
 *
 * Unlike claim-rewards, this intent does not broadcast anything — it just
 * signals the daemon's own in-process halt-and-resume loop
 * (`main.ts`'s `retryBootstrapResolve`) to unblock, then returns
 * immediately; the retried bootstrap's outcome is observed separately via
 * `GET /v1/bootstrap` polling, not awaited here. Because there is no
 * broadcast to race, claim-rewards' module-level single-flight queue has no
 * analogue here — resolving an already-resolved signal twice is a harmless
 * no-op. (The HTTP route front-end, `api/setup-retry-endpoint.ts`, still
 * keeps its OWN pre-existing per-route in-flight coalescing so concurrent
 * POSTs against the SAME daemon don't fork two state machines — that is a
 * route-level concern, not something this module needs to duplicate.)
 *
 * Also unlike claim-rewards, this intent cannot run standalone: "retry"
 * only means something against a *live* daemon's in-memory halted-bootstrap
 * state, so `retryBootstrap` is always the daemon's own closure. The CLI
 * front-end (`cli/commands/bootstrap-retry.ts`) therefore calls this
 * intent over the loopback HTTP control route rather than invoking it
 * in-process the way `claim-rewards`'s CLI verb does.
 */

export interface BootstrapRetryIntentInput {
  /**
   * Closure that re-enters the halted bootstrap state machine. Resolves
   * once the signal is delivered (not once the retried bootstrap attempt
   * settles); rejects if the daemon is not currently halted.
   */
  retryBootstrap: () => Promise<void>;
}

export interface BootstrapRetryIntentResult {
  schemaVersion: 1;
  generatedAt: string;
  verb: 'bootstrap-retry';
  ok: boolean;
  error?: string;
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

export async function bootstrapRetryIntent(
  input: BootstrapRetryIntentInput,
): Promise<BootstrapRetryIntentResult> {
  try {
    await input.retryBootstrap();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'bootstrap-retry',
      ok: true,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'bootstrap-retry',
      ok: false,
      error: serializeError(err),
    };
  }
}
