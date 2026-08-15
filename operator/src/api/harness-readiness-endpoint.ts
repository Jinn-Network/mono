/**
 * GET /v1/harnesses/readiness  — composed snapshot of all joined harnesses
 * GET /v1/harnesses/:name/readiness — single-harness snapshot
 *
 * Both read from a HarnessReadinessRegistry instance (single-writer; readers
 * never block). See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 *
 * Two config shapes are supported:
 *   - `{ registry }` — direct (used by tests and the daemon path).
 *   - `{ getRegistry }` — lazy lookup (used by the HTTP server, where the
 *     registry is constructed AFTER startApiServer because it depends on
 *     post-bootstrap state). The lazy form lets the route be registered
 *     eagerly at server start so Hono's matcher includes it before the
 *     first request — adding routes after the matcher is built throws
 *     `Can not add a route since the matcher is already built` (jinn-mono-u34i
 *     surfaced this on the canary once Stage 1 stopped halting bootstrap).
 */
import type { Hono } from 'hono';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';

export type HarnessReadinessRoutesConfig =
  | { registry: HarnessReadinessRegistry }
  | { getRegistry: () => HarnessReadinessRegistry | null };

export function addHarnessReadinessRoutes(app: Hono, config: HarnessReadinessRoutesConfig): void {
  const getRegistry: () => HarnessReadinessRegistry | null =
    'getRegistry' in config ? config.getRegistry : () => config.registry;

  app.get('/v1/harnesses/readiness', (c) => {
    const reg = getRegistry();
    if (!reg) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'Harness readiness registry still initialising' },
        503,
      );
    }
    return c.json(reg.getSnapshot());
  });

  app.get('/v1/harnesses/:name/readiness', (c) => {
    const reg = getRegistry();
    if (!reg) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'Harness readiness registry still initialising' },
        503,
      );
    }
    const name = c.req.param('name');
    const snapshot = reg.getSnapshot();
    const entry = snapshot.harnesses.find((h) => h.harnessName === name);
    if (!entry) {
      return c.json({ error: 'harness_not_found' }, 404);
    }
    return c.json(entry);
  });
}
