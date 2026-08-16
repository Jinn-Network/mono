/**
 * Build the SolverNet catalog response from the daemon's in-memory
 * SolverNet registry. The catalog is descriptive — it tells the SPA what
 * SolverNets exist and what each one supports, so the SPA can render the
 * Configuration > SolverNets section as a catalog of opt-in cards.
 *
 * Operator selection (enabled / role / harness / plugins) is NOT part of
 * the catalog; that lives in `~/.jinn-client/config.json` and is read via
 * `/v1/bootstrap`. The catalog is purely the registry's view of what is
 * available.
 */

export interface SolverNetCatalogEntry {
  name: string;
  description: string;
  state: 'live' | 'available' | 'coming_soon';
  /**
   * Canonical contract identity post-SDK-migration (PRs d4491879 / 26548969):
   * the legacy `intrinsicSolverType: string` (concatenated `id.version`) was
   * removed in favour of the `{id, version}` pair carried by the manifest's
   * contract block. Catalog entries match a manifest's `contract` field
   * directly — no string concatenation on either side.
   */
  contract: { id: string; version: string };
  supportedRoles: ('solving' | 'evaluating')[];
  compatibleHarnesses: Array<{
    name: string;
    version: string;
    supportsRoles: ('solving' | 'evaluating')[];
  }>;
  compatiblePlugins: Array<{ name: string; version: string; source: string }>;
}

export interface SolverNetsCatalogResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: SolverNetCatalogEntry[];
}

export interface BuildSolverNetsCatalogInput {
  registered: SolverNetCatalogEntry[];
}

export function buildSolverNetsCatalog(input: BuildSolverNetsCatalogInput): SolverNetsCatalogResponse {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nets: input.registered,
  };
}
