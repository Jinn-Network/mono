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
   * When set, resolve the plug-in in place (use the source path directly as
   * `root`) instead of copying it into the vendor root. Read-only inspection
   * verbs (`show`, `validate`) pass this so they never silently write to
   * `~/.jinn-client/solver-plugins/`. Only honoured for `bundled` / `local`
   * sources; remote kinds still require a pre-vendored root.
   */
  noVendor?: boolean;
}
