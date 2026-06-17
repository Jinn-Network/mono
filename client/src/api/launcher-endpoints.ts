/**
 * Launcher mode HTTP routes. Mounted under `/v1/launcher/*` and gated by the
 * shared UI token (see server.ts). This module is intentionally thin — the
 * heavy lifting lives in `launcher-status.ts` / `launcher-tasks.ts` so each
 * gather function can be unit-tested without spinning up the full Hono server.
 *
 * Currently registers:
 *   GET   /v1/launcher/status              — per-SolverNet generator + budget snapshot.
 *   GET   /v1/launcher/tasks               — paginated posted-Task list.
 *   PATCH /v1/launcher/solvernets/:name    — retired (410 Gone, Task 22).
 */
import type { Hono } from 'hono';
import {
  gatherLauncherStatus,
  type GatherLauncherStatusDeps,
} from './launcher-status.js';
import {
  gatherLauncherTasks,
  type GatherLauncherTasksDeps,
} from './launcher-tasks.js';
import type { persistTopLevelConfigValue } from '../config.js';

export interface LauncherRoutesDeps extends Omit<GatherLauncherStatusDeps, 'config'> {
  /**
   * Read the live config snapshot. Resolved per-request so subsequent SPA
   * polls observe SolverNet edits without a daemon restart.
   */
  getConfig: () => GatherLauncherStatusDeps['config'];
  /**
   * Posted-Task accessor. Resolved once at construction; the deps
   * shape narrows the cross-route surface area that route handlers can see.
   */
  tasksDeps: Omit<GatherLauncherTasksDeps, 'config'>;
  /**
   * Path to the operator config.json. Retained for API compatibility with
   * earlier wiring; unused after Task 22 retired the launcher PATCH.
   */
  configPath?: string;
  /**
   * Persist a top-level config key. Retained for API compatibility with
   * earlier wiring; unused after Task 22 retired the launcher PATCH.
   */
  persistConfigValue?: typeof persistTopLevelConfigValue;
  /**
   * Cache-invalidation hook. Retained for API compatibility with earlier
   * wiring; unused after Task 22 retired the launcher PATCH.
   */
  onSolverNetsUpdated?: (solverNets: Record<string, Record<string, unknown>>) => void;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const CURSOR_PREFIX = 'before:';

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(parsed)));
}

function parseCursor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith(CURSOR_PREFIX)) return raw.slice(CURSOR_PREFIX.length);
  // Be permissive: a bare ISO timestamp is treated as `before:<iso>` so the
  // SPA can pass either form without a wrapper layer.
  return raw;
}

function parseManifestCid(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function addLauncherRoutes(app: Hono, deps: LauncherRoutesDeps): void {
  app.get('/v1/launcher/status', async (c) => {
    const body = await gatherLauncherStatus({ ...deps, config: deps.getConfig() });
    return c.json(body);
  });

  app.get('/v1/launcher/tasks', async (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const before = parseCursor(c.req.query('cursor'));
    const manifestCid = parseManifestCid(c.req.query('manifestCid'));
    const body = await gatherLauncherTasks(
      { ...deps.tasksDeps, config: deps.getConfig() },
      { limit, ...(before ? { before } : {}), ...(manifestCid ? { manifestCid } : {}) },
    );
    return c.json(body);
  });

  // Legacy launcher-mode SolverNet patch (`PATCH /v1/launcher/solvernets/:name`)
  // was retired by Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md
  // — the operator-config `'launching'` role + top-level `predictionV1*`
  // generator-config keys it managed have been removed from the schema.
  // Launched-record-driven launcher SolverNet edits now flow through the
  // launched-record subsystem (see solvernets-endpoints.ts / Task 14). The
  // route returns 410 Gone so SPA clients on stale builds get a clear
  // signal rather than a silently-succeeding write to dropped fields.
  app.patch('/v1/launcher/solvernets/:name', async (c) => {
    return c.json(
      {
        error: 'gone',
        message:
          "PATCH /v1/launcher/solvernets/:name is retired — operator-config 'launching' role and predictionV1* keys were removed by Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md. Use the launched-record SolverNet endpoints instead.",
      },
      410,
    );
  });
}
