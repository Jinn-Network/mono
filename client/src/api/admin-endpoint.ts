/**
 * Admin endpoints for operator MCP write tools.
 *
 * Mounted only when ui auth is configured (so they're token-gated). Currently
 * supports: daemon_restart (real, exits the process gracefully — see
 * `restart-daemon.ts` for the respawn / headless semantics), daemon_stop
 * (exits the process and stays down — never respawns), manual reward claims,
 * and loop pause/resume (stubbed — returns not_implemented).
 */
import type { Hono } from 'hono';
import { claimRewardsIntent, type ClaimRewardsIntentInput } from '../intents/claim-rewards.js';

export interface AdminRestartOptions {
  /**
   * When true, the daemon respawns even under a supervisor (`JINN_NO_UI=1`).
   * The operator dashboard sets this — when the operator clicks Restart they
   * explicitly want the daemon back. Default is `false`, which preserves the
   * supervisor-driven flow other callers (MCP tools, signals) depend on.
   */
  forceRespawn?: boolean;
}

/**
 * Deps the claim-rewards intent module (`intents/claim-rewards.ts`) needs,
 * minus `strict` (the route always claims strictly, same as the CLI) and
 * `source` (the route always supplies the literal `'admin-route'`).
 */
export type ClaimRewardsRouteContext = Omit<ClaimRewardsIntentInput, 'strict' | 'source'>;

export interface AdminEndpointConfig {
  onRestartRequested: (opts: AdminRestartOptions) => void;
  onStopRequested: () => void;
  /**
   * §4.1 intent-module law: `POST /api/admin/claim-rewards` is a thin
   * front-end over `claimRewardsIntent` — it builds its signer context from
   * the daemon's OWN already-constructed wallet/client objects (never from
   * the keystore, never through the CLI module) and never runs the CLI's
   * daemon-guard (that guard exists only to stop a standalone CLI process
   * racing this same daemon; a route running inside the daemon has nothing
   * to guard against).
   *
   * A holder ref because those signer/client objects are built post-bootstrap
   * in main.ts, after this config is constructed (routes register eagerly at
   * server start — Hono freezes its matcher, so routes can't be added later;
   * see the `solverNetsLauncher` / `harnessReadiness` holders for the same
   * pattern). `current` is `undefined` until bootstrap completes.
   */
  claimRewards: { holder: { current: ClaimRewardsRouteContext | undefined } };
}

export function addAdminRoutes(app: Hono, cfg: AdminEndpointConfig): void {
  app.post('/api/admin/restart', async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // No body / non-JSON — that's fine, treat as default options.
    }
    const forceRespawn = (body as { forceRespawn?: unknown })?.forceRespawn === true;
    // Defer the actual exit so the response can flush first.
    setTimeout(() => {
      try {
        cfg.onRestartRequested({ forceRespawn });
      } catch (err) {
        console.error('[admin] restart hook threw:', err);
      }
    }, 50);
    return c.json({ ok: true, scheduled: true });
  });

  app.post('/api/admin/stop', (c) => {
    // Same flush-then-exit pattern as restart, but always a pure exit — no
    // respawn under any env. The operator clicked Stop; they want the daemon
    // down until they explicitly start it again.
    setTimeout(() => {
      try {
        cfg.onStopRequested();
      } catch (err) {
        console.error('[admin] stop hook threw:', err);
      }
    }, 50);
    return c.json({ ok: true, scheduled: true });
  });

  app.post('/api/admin/claim-rewards', async (c) => {
    const routeCtx = cfg.claimRewards.holder.current;
    if (!routeCtx) {
      return c.json(
        {
          ok: false,
          error: 'Daemon has not finished bootstrap yet; reward-claim signer context is not ready.',
        },
        503,
      );
    }
    try {
      const result = await claimRewardsIntent({ ...routeCtx, strict: true, source: 'admin-route' });
      return c.json({ ok: true, result }, 200);
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/api/admin/loop/:loop/:action', (c) => {
    const loop = c.req.param('loop');
    const action = c.req.param('action');
    return c.json({
      schemaVersion: 1,
      ok: false,
      reason: 'not_implemented',
      loop,
      action,
    });
  });
}
