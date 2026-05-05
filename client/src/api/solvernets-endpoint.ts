/**
 * GET /v1/solvernets — exposes the SolverNet registry catalog to the SPA.
 *
 * Driven by the daemon's in-memory registry; descriptive only. Operator
 * config edits go through `/v1/setup/solvernets/:name`, not here.
 */
import type { Hono } from 'hono';
import { buildSolverNetsCatalog, type SolverNetCatalogEntry } from './solvernets-catalog-build.js';

export interface SolverNetsRegistry {
  list(): SolverNetCatalogEntry[];
}

export interface SolverNetsRoutesConfig {
  registry: SolverNetsRegistry;
}

export function addSolverNetsRoutes(app: Hono, config: SolverNetsRoutesConfig): void {
  app.get('/v1/solvernets', (c) =>
    c.json(buildSolverNetsCatalog({ registered: config.registry.list() })),
  );
}
