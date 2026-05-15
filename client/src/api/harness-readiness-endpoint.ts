/**
 * GET /v1/harnesses/readiness  — composed snapshot of all joined harnesses
 * GET /v1/harnesses/:name/readiness — single-harness snapshot
 *
 * Both read from a HarnessReadinessRegistry instance (single-writer; readers
 * never block). See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 */
import type { Hono } from 'hono';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';

export interface HarnessReadinessRoutesConfig {
  registry: HarnessReadinessRegistry;
}

export function addHarnessReadinessRoutes(app: Hono, config: HarnessReadinessRoutesConfig): void {
  app.get('/v1/harnesses/readiness', (c) => {
    return c.json(config.registry.getSnapshot());
  });

  app.get('/v1/harnesses/:name/readiness', (c) => {
    const name = c.req.param('name');
    const snapshot = config.registry.getSnapshot();
    const entry = snapshot.harnesses.find((h) => h.harnessName === name);
    if (!entry) {
      return c.json({ error: 'harness_not_found' }, 404);
    }
    return c.json(entry);
  });
}
