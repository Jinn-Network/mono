/**
 * GET /api/harness/status
 *
 * Reports the operator's current harness mode + content-addressed codeDigest
 * for the dashboard's HarnessStatusPanel. Frozen-mode contract surface:
 * a stable codeDigest visible to the operator gives them confidence that the
 * benchmark snapshot is reproducible.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2
 */
import type { Hono } from 'hono';

export interface HarnessStatusResponse {
  mode: 'train' | 'frozen' | string;
  codeDigest: string;
  lastModeSwitchAt?: number;
}

export interface HarnessStatusDeps {
  getStatus(): Promise<HarnessStatusResponse>;
}

export function addHarnessStatusRoutes(app: Hono, deps: HarnessStatusDeps): void {
  app.get('/api/harness/status', async (c) => {
    try {
      const body = await deps.getStatus();
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'harness_status_failed', message }, 500);
    }
  });
}
