export type SolverPluginSourceKind =
  | 'bundled'
  | 'local'
  | 'npm'
  | 'git'
  | 'github'
  | 'claude';

export type SolverPluginEntry =
  | string
  | {
      name?: string;
      source: string;
      version?: string;
    };

export interface SolverPluginManifest {
  name: string;
  version: string;
  description?: string;
  jinn: {
    supports: string[];
    capabilities?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
    skills?: string[];
  };
  [key: string]: unknown;
}

export interface LoadedSolverPlugin {
  name: string;
  version: string;
  supports: string[];
  solverType?: string;
  source: string;
  sourceKind: SolverPluginSourceKind;
  root: string;
  manifestPath: string;
  manifest: SolverPluginManifest;
  sha256: string;
  cid?: string;
}

export interface ResolveSolverPluginOptions {
  bundledRoot?: string;
  vendorRoot?: string;
  /**
   * Deprecated: bundled and local sources always resolve in place (#1242).
   * Retained for CLI callers that still pass it; has no effect.
   */
  noVendor?: boolean;
}
