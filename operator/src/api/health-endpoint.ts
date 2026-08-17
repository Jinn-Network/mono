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
import { healthResponse, readyResponse } from '@jinn-network/read-plane';
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
    const body: HealthResponse = healthResponse();
    return c.json(body);
  });

  app.get('/ready', (c) => {
    const reason = getDaemonReadiness();
    const cause =
      reason === 'degraded' && config.earningDir
        ? (readBootstrapError(config.earningDir)?.code ?? undefined)
        : undefined;
    const { status, body } = readyResponse({ reason, cause });
    return c.json(body as ReadyResponse, status);
  });
}
