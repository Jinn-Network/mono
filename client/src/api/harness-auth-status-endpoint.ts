/**
 * GET /v1/harnesses/auth-status — per-harness credential source + masked
 * last-4 suffix + file mtime + loaded/missing/unknown state (#564).
 *
 * NEVER returns full key bytes — only the suffix and metadata. Reads from the
 * HarnessReadinessRegistry's harness instance map; each harness's
 * `getAuthSource()` declares WHERE its credential lives and the shared
 * `resolveHarnessAuthStatus` helper owns the safe read.
 *
 * Mounts with the same `{ registry }` / `{ getRegistry }` union as the
 * readiness endpoint so the HTTP server can register the route eagerly and
 * dereference the post-bootstrap holder per request.
 */
import type { Hono } from 'hono';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import {
  resolveHarnessAuthStatus,
  type HarnessAuthStatusResponse,
} from '../harnesses/auth-source.js';

export type HarnessAuthStatusRoutesConfig =
  | { registry: HarnessReadinessRegistry }
  | { getRegistry: () => HarnessReadinessRegistry | null };

export function addHarnessAuthStatusRoutes(
  app: Hono,
  config: HarnessAuthStatusRoutesConfig,
): void {
  const getRegistry: () => HarnessReadinessRegistry | null =
    'getRegistry' in config ? config.getRegistry : () => config.registry;

  app.get('/v1/harnesses/auth-status', async (c) => {
    const reg = getRegistry();
    if (!reg) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'Harness registry still initialising' },
        503,
      );
    }
    const harnesses = reg.getHarnesses();
    const entries = await Promise.all(
      Object.values(harnesses).map((h) => resolveHarnessAuthStatus(h)),
    );
    // Stable order by harness name for deterministic rendering.
    entries.sort((a, b) => a.harnessName.localeCompare(b.harnessName));
    const body: HarnessAuthStatusResponse = { harnesses: entries };
    return c.json(body);
  });
}
