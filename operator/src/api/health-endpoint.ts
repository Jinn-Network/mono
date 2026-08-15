/**
 * `GET /health` + `GET /ready` (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.1, §14.5; issue #2404).
 *
 * Both are mounted UNGATED in server.ts (the only ungated operator-listener routes besides
 * `/metrics`, §6.2) — see the gate-list comment there.
 *
 * `getDaemonReadiness` is injected as a plain function rather than imported from
 * `daemon/loop-heartbeat.js` directly: `operator/src/api/` must never import
 * `operator/src/daemon/` (architecture boundary, #1584 —
 * `test/architecture/api-daemon-boundary.test.ts`). The production caller (main.ts /
 * daemon.ts's self-start branch) passes the shared holder's `getDaemonReadiness` straight
 * through. Absent (bare/test servers), this defaults to always-`ready` — matching
 * `daemon/loop-heartbeat.ts`'s own default for every caller that never touches the holder.
 */
import type { Hono } from 'hono';
import { readBootstrapError } from '../errors/persisted-bootstrap-error.js';
import type { HealthResponse, ReadyResponse } from './contract/health.js';

/** Mirrors `daemon/loop-heartbeat.ts`'s `DaemonReadiness` union — restated, not imported (#1584). */
export type HealthDaemonReadiness = 'bootstrapping' | 'ready' | 'degraded';

export interface HealthRoutesConfig {
  /**
   * Read only for the `degraded` cause lookup (a persisted `bootstrap-error.json` envelope
   * code, when one exists) — absent on bare/test servers, in which case `cause` is simply
   * omitted from the `/ready` body rather than fabricated.
   */
  earningDir?: string;
  /** See module docstring. Defaults to `() => 'ready'` when not supplied. */
  getDaemonReadiness?: () => HealthDaemonReadiness;
}

export function addHealthRoutes(app: Hono, config: HealthRoutesConfig = {}): void {
  const getDaemonReadiness = config.getDaemonReadiness ?? ((): HealthDaemonReadiness => 'ready');

  app.get('/health', (c) => {
    const body: HealthResponse = { ok: true };
    return c.json(body);
  });

  app.get('/ready', (c) => {
    const reason = getDaemonReadiness();
    // §6.1's exact mapping: 200 for `ready` AND `degraded` (both mean "do not restart me" —
    // a 503 here would restart-loop a daemon correctly waiting for funding, the exact
    // absorbing state §5 prevents); 503 for `bootstrapping`. The readiness union has no
    // fourth "integrity-failed" member today — an integrity-class halt calls `emitEnvelope`
    // and `process.exit`s before the API server ever binds (spec §5) — so the `else` branch
    // below is reserved for that case if one is ever added to the union.
    const status = reason === 'ready' || reason === 'degraded' ? 200 : 503;
    const cause =
      reason === 'degraded' && config.earningDir
        ? (readBootstrapError(config.earningDir)?.code ?? undefined)
        : undefined;
    const body: ReadyResponse = {
      reason,
      ...(cause ? { cause } : {}),
      accepting_work: reason === 'ready',
    };
    return c.json(body, status);
  });
}
